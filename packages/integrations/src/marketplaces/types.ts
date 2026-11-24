/**
 * Поиск товаров по маркетплейсам (бонус задания). Адаптеры работают без LLM:
 * получают запрос, возвращают нормализованные карточки. Разбор запроса, сравнение и вывод — у агента.
 */
export type MarketplaceId = "ozon" | "wildberries" | "yandex_market";

export interface ProductQuery {
  text: string;
  priceMin?: number;
  priceMax?: number;
  sort?: "relevance" | "price_asc" | "price_desc" | "rating";
  limit?: number;
}

export interface ProductOffer {
  marketplace: MarketplaceId;
  /** Артикул площадки: WB nmId, Ozon sku, id карточки Маркета. */
  externalId: string;
  title: string;
  url: string;
  /** Цена в рублях, которую видит покупатель без входа в аккаунт. */
  price: number;
  oldPrice?: number;
  rating?: number;
  reviews?: number;
  seller?: string;
  /** Когда снята цена (ISO 8601) — цены меняются быстро, показываем владельцу. */
  fetchedAt: string;
}

export interface MarketplaceAdapter {
  readonly id: MarketplaceId;
  search(query: ProductQuery, signal?: AbortSignal): Promise<ProductOffer[]>;
}

/** captcha — капча или антибот-проверка; forbidden — 403/бан по IP; rate_limited — 429 или наш лимит частоты. */
export type BlockReason = "captcha" | "forbidden" | "rate_limited";

/** Ошибки, при которых адаптер прекращает работу, а не пытается обойти защиту. */
export class MarketplaceBlockedError extends Error {
  constructor(
    readonly marketplace: MarketplaceId,
    readonly reason: BlockReason,
  ) {
    super(`${marketplace}: доступ ограничен (${reason})`);
  }
}
