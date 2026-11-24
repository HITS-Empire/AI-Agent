import { curlFetch } from "./curlFetch";
import {
  MarketplaceBlockedError,
  type MarketplaceAdapter,
  type ProductOffer,
  type ProductQuery,
} from "./types";

const BASE_URL = "https://market.yandex.ru";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36";

export interface YandexMarketOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * Яндекс Маркет: обычный GET страницы поиска без входа в аккаунт.
 * Карточки берутся из JSON в атрибуте data-zone-data у сниппетов (`data-zone-name="productSnippet"`);
 * в первой выдаче ~8 карточек, остальные подгружаются скриптом — их не добираем.
 * Капча или 403/429 → MarketplaceBlockedError, никаких обходов.
 */
export function createYandexMarketAdapter(
  options: YandexMarketOptions = {},
): MarketplaceAdapter {
  // по умолчанию curl: встроенный fetch получает капчу (см. curlFetch.ts)
  const fetchImpl =
    options.fetchImpl ??
    (process.env.MARKETPLACE_HTTP === "fetch" ? fetch : curlFetch);
  const baseUrl = options.baseUrl ?? BASE_URL;
  const now = options.now ?? (() => new Date());

  return {
    id: "yandex_market",
    async search(query, signal) {
      const url = buildSearchUrl(query, baseUrl);
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 20_000);
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml",
          "accept-language": "ru-RU,ru;q=0.9",
        },
      });

      if (response.status === 429)
        throw new MarketplaceBlockedError("yandex_market", "rate_limited");
      if (response.status === 403)
        throw new MarketplaceBlockedError("yandex_market", "forbidden");
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location") ?? "";
        throw new MarketplaceBlockedError(
          "yandex_market",
          /captcha/i.test(location) ? "captcha" : "forbidden",
        );
      }
      if (!response.ok)
        throw new Error(`yandex_market: HTTP ${response.status}`);

      const html = await response.text();
      if (isCaptchaPage(html))
        throw new MarketplaceBlockedError("yandex_market", "captcha");

      const offers = parseYandexMarketSearch(html, baseUrl, now());
      return filterAndSort(offers, query);
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

function filterAndSort(
  offers: ProductOffer[],
  query: ProductQuery,
): ProductOffer[] {
  let result = offers.filter(
    (o) =>
      (query.priceMin === undefined || o.price >= query.priceMin) &&
      (query.priceMax === undefined || o.price <= query.priceMax),
  );
  if (query.sort === "price_asc")
    result = result.sort((a, b) => a.price - b.price);
  if (query.sort === "price_desc")
    result = result.sort((a, b) => b.price - a.price);
  if (query.sort === "rating")
    result = result.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return result.slice(0, query.limit ?? 10);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const n = Number(value.replace(/[\s\u00a0\u2009]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos|#39|nbsp);/gi,
    (_, e: string) => {
      const lower = e.toLowerCase();
      if (lower.startsWith("#x"))
        return String.fromCodePoint(parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(parseInt(lower.slice(1), 10));
      return (
        { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'", nbsp: "\u00a0" }[
          lower
        ] ?? _
      );
    },
  );
}
