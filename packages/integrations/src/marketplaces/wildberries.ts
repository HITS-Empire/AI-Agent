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

const BASE_URL = "https://www.wildberries.ru";
const CARD_SELECTOR = "article.product-card";

export interface WildberriesOptions {
  renderer?: PageRenderer;
  baseUrl?: string;
  now?: () => Date;
}

/**
 * Wildberries: публичная страница поиска в headless Chromium (infra/browser), без входа.
 * На антибот-странице («Подозрительная активность», HTTP 498) — MarketplaceBlockedError, без обходов.
 */
export function createWildberriesAdapter(
  options: WildberriesOptions = {},
): MarketplaceAdapter {
  const renderer = options.renderer ?? createBrowserRenderer();
  const baseUrl = options.baseUrl ?? BASE_URL;
  const now = options.now ?? (() => new Date());
  return {
    id: "wildberries",
    async search(query, signal) {
      const page = await loadSearchPage(
        renderer,
        "wildberries",
        buildWildberriesSearchUrl(query, baseUrl),
        { waitFor: CARD_SELECTOR, blocked: wildberriesBlock },
        signal,
      );
      return filterAndSort(
        parseWildberriesSearch(page.html, baseUrl, now()),
        query,
      );
    },
  };
}

export function buildWildberriesSearchUrl(
  query: ProductQuery,
  baseUrl = BASE_URL,
): string {
  const params = new URLSearchParams({ search: query.text });
  const sort = {
    relevance: "popular",
    price_asc: "priceup",
    price_desc: "pricedown",
    rating: "rate",
  }[query.sort ?? "relevance"];
  params.set("sort", sort);
  if (query.priceMin !== undefined || query.priceMax !== undefined) {
    // WB принимает диапазон в копейках: priceU=от;до
    const from = Math.floor((query.priceMin ?? 0) * 100);
    const to = Math.ceil((query.priceMax ?? 10_000_000) * 100);
    params.set("priceU", `${from};${to}`);
  }
  return `${baseUrl}/catalog/0/search.aspx?${params.toString()}`;
}

/** Антибот WB: HTTP 498 и страница «Подозрительная активность» с обратным отсчётом. */
export function wildberriesBlock(
  page: Pick<RenderedPage, "status" | "html">,
): BlockReason | undefined {
  if (
    page.status === 498 ||
    /Подозрительная активность|captcha-support@rwb\.ru|id="s-key"/.test(
      page.html,
    )
  )
    return "captcha";
  return undefined;
}

const CARD_RE =
  /<article\b[^>]*\bdata-nm-id="(\d+)"[^>]*>([\s\S]*?)<\/article>/g;

/** Разбор выдачи по разметке карточек `article.product-card[data-nm-id]`. */
export function parseWildberriesSearch(
  html: string,
  baseUrl = BASE_URL,
  fetchedAt = new Date(),
): ProductOffer[] {
  const offers: ProductOffer[] = [];
  const seen = new Set<string>();
  for (const [, id, body] of html.matchAll(CARD_RE)) {
    if (!id || !body || seen.has(id)) continue;
    const price = toNumber(
      stripTags(
        pick(
          body,
          /<ins\b[^>]*class="[^"]*price__lower-price[^"]*"[^>]*>([\s\S]*?)<\/ins>/,
        ),
      ),
    );
    if (price === undefined || price <= 0) continue;
    const oldPrice = toNumber(
      stripTags(pick(body, /<del\b[^>]*>([\s\S]*?)<\/del>/)),
    );
    const brand = stripTags(
      pick(
        body,
        /class="[^"]*product-card__brand[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      ),
    );
    const name = stripTags(
      pick(
        body,
        /class="[^"]*product-card__name[^"]*"[^>]*>([\s\S]*?)<\/span>/,
      ),
    ).replace(/^\/\s*/, "");
    const label = decodeEntities(pick(body, /aria-label="([^"]*)"/));
    const title = [brand, name].filter(Boolean).join(" / ") || label;
    if (!title) continue;
    const rating = toNumber(
      stripTags(
        pick(
          body,
          /class="[^"]*address-rate-mini[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        ),
      ),
    );
    const reviews = toNumber(
      stripTags(
        pick(
          body,
          /class="[^"]*product-card__count[^"]*"[^>]*>([\s\S]*?)<\/span>/,
        ),
      ).replace(/\D/g, ""),
    );
    seen.add(id);
    offers.push({
      marketplace: "wildberries",
      externalId: id,
      title,
      url: `${baseUrl}/catalog/${id}/detail.aspx`,
      price,
      ...(oldPrice !== undefined && oldPrice > price ? { oldPrice } : {}),
      ...(rating !== undefined && rating > 0 ? { rating } : {}),
      ...(reviews !== undefined ? { reviews } : {}),
      ...(brand ? { seller: brand } : {}),
      fetchedAt: fetchedAt.toISOString(),
    });
  }
  return offers;
}

function pick(text: string, re: RegExp): string {
  return re.exec(text)?.[1] ?? "";
}
