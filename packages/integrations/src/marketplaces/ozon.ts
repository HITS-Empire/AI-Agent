import {
  createBrowserRenderer,
  loadSearchPage,
  type PageRenderer,
  type RenderedPage,
} from "./browser";
import type {
  BlockReason,
  MarketplaceAdapter,
  ProductOffer,
  ProductQuery,
} from "./types";
import { decodeEntities, filterAndSort, stripTags, toNumber } from "./util";

const BASE_URL = "https://www.ozon.ru";
const TILE_SELECTOR = 'a[href*="/product/"]';

export interface OzonOptions {
  renderer?: PageRenderer;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Ozon: публичная страница поиска в headless Chromium (infra/browser), без входа.
 * Антибот Ozon («Похоже, нет соединения», HTTP 403, `__rr=` в адресе) → MarketplaceBlockedError, без обходов.
 */
export function createOzonAdapter(
  options: OzonOptions = {},
): MarketplaceAdapter {
  const renderer = options.renderer ?? createBrowserRenderer();
  const baseUrl = options.baseUrl ?? BASE_URL;
  const now = options.now ?? (() => new Date());
  return {
    id: "ozon",
    async search(query, signal) {
      const page = await loadSearchPage(
        renderer,
        "ozon",
        buildOzonSearchUrl(query, baseUrl),
        { waitFor: TILE_SELECTOR, blocked: ozonBlock },
        signal,
      );
      return filterAndSort(parseOzonSearch(page.html, baseUrl, now()), query);
    },
  };
}

export function buildOzonSearchUrl(
  query: ProductQuery,
  baseUrl = BASE_URL,
): string {
  const params = new URLSearchParams({ text: query.text, from_global: "true" });
  const sort = {
    relevance: undefined,
    price_asc: "price",
    price_desc: "price_desc",
    rating: "rating",
  }[query.sort ?? "relevance"];
  if (sort) params.set("sorting", sort);
  if (query.priceMin !== undefined || query.priceMax !== undefined)
    params.set(
      "currency_price",
      `${(query.priceMin ?? 0).toFixed(3)};${(query.priceMax ?? 10_000_000).toFixed(3)}`,
    );
  return `${baseUrl}/search/?${params.toString()}`;
}

/** Антибот Ozon: 403, `__rr=` в итоговом адресе, страница «Похоже, нет соединения» с номером инцидента. */
export function ozonBlock(
  page: Pick<RenderedPage, "status" | "finalUrl" | "html">,
): BlockReason | undefined {
  if (
    /[?&]__rr=/.test(page.finalUrl) ||
    /Похоже, нет(&nbsp;|\s)соединения|Инцидент: fab_/.test(page.html)
  )
    return "captcha";
  if (page.status === 403) return "forbidden";
  return undefined;
}

const PRODUCT_LINK_RE =
  /<a\b[^>]*href="(\/product\/[^"?#]*?-(\d{5,})\/?)(?:[?#][^"]*)?"[^>]*>/g;
const PRICE_RE = /(\d[\d\s\u00a0\u2009\u202f]*)\s*₽/g;

/**
 * Разбор выдачи: классы Ozon обфусцированы, поэтому опираемся на устойчивое — ссылки `/product/…-<sku>/`.
 * Сегмент карточки — от первой ссылки на sku до первой ссылки на следующий sku.
 * Цены — суммы с «₽» в сегменте: меньшая — текущая, большая — старая. Рейтинг/отзывы — «4.9» и «123 отзыва».
 */
export function parseOzonSearch(
  html: string,
  baseUrl = BASE_URL,
  fetchedAt = new Date(),
): ProductOffer[] {
  const starts: Array<{ sku: string; path: string; index: number }> = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(PRODUCT_LINK_RE)) {
    const sku = m[2]!;
    if (seen.has(sku)) continue;
    seen.add(sku);
    starts.push({ sku, path: m[1]!, index: m.index ?? 0 });
  }

  const offers: ProductOffer[] = [];
  starts.forEach((start, i) => {
    const segment = html.slice(
      start.index,
      starts[i + 1]?.index ?? Math.min(html.length, start.index + 20_000),
    );
    const prices = [...stripTags(segment).matchAll(PRICE_RE)]
      .map((m) => toNumber(m[1]))
      .filter((n): n is number => n !== undefined && n > 0);
    if (prices.length === 0) return;
    const price = prices[0]!;
    const oldPrice = prices.slice(1, 3).find((p) => p > price);

    const titles = [
      ...segment.matchAll(
        /<a\b[^>]*href="\/product\/[^"]*"[^>]*>([\s\S]*?)<\/a>/g,
      ),
    ]
      .map((m) => stripTags(m[1] ?? ""))
      .filter((t) => t && !/₽/.test(t));
    const title = titles.sort((a, b) => b.length - a.length)[0];
    if (!title) return;

    const text = stripTags(segment);
    const rating = toNumber(/(?:^|\s)([1-5][.,]\d)(?=\s)/.exec(text)?.[1]);
    const reviews = toNumber(
      /(?:^|[^\d.,])(\d{1,3}(?:[\s\u00a0]\d{3})+|\d+)\s*отзыв/.exec(text)?.[1],
    );
    offers.push({
      marketplace: "ozon",
      externalId: start.sku,
      title: decodeEntities(title),
      url: new URL(start.path, baseUrl).toString(),
      price,
      ...(oldPrice !== undefined ? { oldPrice } : {}),
      ...(rating !== undefined ? { rating } : {}),
      ...(reviews !== undefined ? { reviews } : {}),
      fetchedAt: fetchedAt.toISOString(),
    });
  });
  return offers;
}
