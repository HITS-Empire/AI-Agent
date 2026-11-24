import {
  loadSearchPage,
  createBrowserRenderer,
  type PageRenderer,
} from "./browser";
import type {
  BlockReason,
  MarketplaceAdapter,
  ProductOffer,
  ProductQuery,
} from "./types";
import { decodeEntities, filterAndSort, toNumber } from "./util";

const BASE_URL = "https://market.yandex.ru";
const SNIPPET_SELECTOR = '[data-zone-name="productSnippet"]';

export interface YandexMarketOptions {
  renderer?: PageRenderer;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Яндекс Маркет: публичная страница поиска без входа, открытая в headless Chromium (infra/browser).
 * Карточки берутся из JSON в атрибуте data-zone-data у сниппетов (`data-zone-name="productSnippet"`).
 * Капча (showcaptcha/SmartCaptcha) или 403/429 → MarketplaceBlockedError, без обходов.
 */
export function createYandexMarketAdapter(
  options: YandexMarketOptions = {},
): MarketplaceAdapter {
  const renderer = options.renderer ?? createBrowserRenderer();
  const baseUrl = options.baseUrl ?? BASE_URL;
  const now = options.now ?? (() => new Date());

  return {
    id: "yandex_market",
    async search(query, signal) {
      const page = await loadSearchPage(
        renderer,
        "yandex_market",
        buildSearchUrl(query, baseUrl),
        {
          waitFor: SNIPPET_SELECTOR,
          blocked: yandexMarketBlock,
        },
        signal,
      );
      return filterAndSort(
        parseYandexMarketSearch(page.html, baseUrl, now()),
        query,
      );
    },
  };
}

export function buildSearchUrl(
  query: ProductQuery,
  baseUrl = BASE_URL,
): string {
  const params = new URLSearchParams({ text: query.text });
  if (query.priceMin !== undefined)
    params.set("pricefrom", String(Math.floor(query.priceMin)));
  if (query.priceMax !== undefined)
    params.set("priceto", String(Math.ceil(query.priceMax)));
  const how = {
    relevance: undefined,
    price_asc: "aprice",
    price_desc: "dprice",
    rating: "rating",
  }[query.sort ?? "relevance"];
  if (how) params.set("how", how);
  return `${baseUrl}/search?${params.toString()}`;
}

/** Страница защиты Маркета: капча (showcaptcha/SmartCaptcha) или 403 «Доступ к сервису временно запрещён». */
export function yandexMarketBlock(page: {
  status: number;
  finalUrl: string;
  html: string;
}): BlockReason | undefined {
  if (
    /showcaptcha|checkcaptcha/i.test(page.finalUrl) ||
    isCaptchaPage(page.html)
  )
    return "captcha";
  if (
    page.status === 403 ||
    /Доступ к(&nbsp;|\s)сервису временно запрещ/.test(page.html)
  )
    return "forbidden";
  return undefined;
}

export function isCaptchaPage(html: string): boolean {
  return (
    /showcaptcha|smartcaptcha|checkcaptcha/i.test(html) &&
    !html.includes('data-zone-name="productSnippet"')
  );
}

interface SnippetData {
  title?: string;
  price?: number | string;
  additionalPrices?: Array<{
    priceType?: string;
    priceValue?: string | number;
  }>;
  rating?: { rating?: number | string; gradesCount?: number | string };
  marketSku?: string | number;
  wareId?: string;
  modelId?: string | number;
  shopId?: string | number;
  isAvailable?: boolean;
  sponsored?: boolean;
}

const SNIPPET_RE = /<div\b[^>]*\bdata-zone-name="productSnippet"[^>]*>/g;
const ZONE_DATA_RE = /\bdata-zone-data="([^"]*)"/;
const CARD_HREF_RE = /href="(\/card\/[^"]+)"/;

/** Разбор HTML выдачи. Экспортирован для тестов на сохранённой фикстуре. */
export function parseYandexMarketSearch(
  html: string,
  baseUrl = BASE_URL,
  fetchedAt = new Date(),
): ProductOffer[] {
  const offers: ProductOffer[] = [];
  const seen = new Set<string>();
  const matches = [...html.matchAll(SNIPPET_RE)];

  matches.forEach((match, i) => {
    const raw = ZONE_DATA_RE.exec(match[0])?.[1];
    if (!raw) return;
    let data: SnippetData;
    try {
      data = JSON.parse(decodeEntities(raw)) as SnippetData;
    } catch {
      return;
    }
    if (!data.title || data.isAvailable === false) return;

    const prices = new Map(
      (data.additionalPrices ?? []).map((p) => [
        p.priceType,
        toNumber(p.priceValue),
      ]),
    );
    const listPrice = toNumber(data.price);
    const price = prices.get("withDiscount") ?? listPrice;
    if (price === undefined || price <= 0) return;

    const externalId = String(
      data.marketSku ?? data.modelId ?? data.wareId ?? "",
    );
    if (!externalId || seen.has(externalId)) return;
    seen.add(externalId);

    // ссылка карточки — первая /card/... после открывающего тега сниппета и до следующего
    const end = matches[i + 1]?.index ?? html.length;
    const segment = html.slice(
      match.index ?? 0,
      Math.min(end, (match.index ?? 0) + 20_000),
    );
    const href = CARD_HREF_RE.exec(segment)?.[1];
    const url = href
      ? cleanCardUrl(decodeEntities(href), baseUrl)
      : `${baseUrl}/search?text=${encodeURIComponent(data.title)}`;

    const rating = toNumber(data.rating?.rating);
    const reviews = toNumber(data.rating?.gradesCount);
    offers.push({
      marketplace: "yandex_market",
      externalId,
      title: data.title,
      url,
      price,
      ...(listPrice !== undefined && listPrice > price
        ? { oldPrice: listPrice }
        : {}),
      ...(rating !== undefined && rating > 0 ? { rating } : {}),
      ...(reviews !== undefined ? { reviews } : {}),
      ...(data.shopId !== undefined ? { seller: `shop:${data.shopId}` } : {}),
      fetchedAt: fetchedAt.toISOString(),
    });
  });

  return offers;
}

/** Оставляем только путь карточки и do-waremd5 (конкретное предложение), убираем трекинг. */
function cleanCardUrl(href: string, baseUrl: string): string {
  const url = new URL(href, baseUrl);
  const ware = url.searchParams.get("do-waremd5");
  url.search = "";
  if (ware) url.searchParams.set("do-waremd5", ware);
  return url.toString();
}

export { decodeEntities };
