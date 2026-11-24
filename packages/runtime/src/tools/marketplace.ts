import type { Tool } from "@burmalda/core";
import {
  searchAll,
  type MarketplaceAdapter,
  type MarketplaceId,
  type ProductOffer,
  type ProductQuery,
} from "@burmalda/integrations";

interface MarketplaceArgs {
  query: string;
  marketplaces?: MarketplaceId[];
  price_min?: number;
  price_max?: number;
  sort?: ProductQuery["sort"];
  limit?: number;
}

export interface MarketplaceToolOptions {
  /** Кэш результатов, чтобы не долбить площадки одинаковыми запросами. */
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Инструмент marketplace_search: параллельный поиск по доступным адаптерам.
 * Возвращает компактный JSON: модель сама отбирает и сравнивает (см. skills/marketplace-search).
 */
export function marketplaceSearchTool(
  adapters: MarketplaceAdapter[],
  options: MarketplaceToolOptions = {},
): Tool<MarketplaceArgs> {
  const ttl = options.cacheTtlMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: string }>();
  const ids = adapters.map((a) => a.id);

  return {
    name: "marketplace_search",
    description:
      `Поиск товаров на маркетплейсах без входа в аккаунт. Доступны: ${ids.join(", ") || "нет"}. ` +
      "Возвращает карточки: площадка, название, цена в рублях, старая цена, рейтинг, отзывы, ссылка, время снятия цены, " +
      "и список недоступных площадок (капча/блокировка — не обходить).",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Короткий поисковый запрос на русском",
        },
        marketplaces: {
          type: "array",
          items: { type: "string", enum: ids },
          description: "Площадки; по умолчанию все доступные",
        },
        price_min: { type: "number", description: "Минимальная цена, ₽" },
        price_max: { type: "number", description: "Максимальная цена, ₽" },
        sort: {
          type: "string",
          enum: ["relevance", "price_asc", "price_desc", "rating"],
        },
        limit: {
          type: "number",
          description: "Карточек с каждой площадки, до 10",
        },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const selected = adapters.filter(
        (a) => !args.marketplaces?.length || args.marketplaces.includes(a.id),
      );
      if (selected.length === 0) return "Нет доступных площадок для поиска.";
      const query: ProductQuery = {
        text: args.query,
        ...(args.price_min !== undefined ? { priceMin: args.price_min } : {}),
        ...(args.price_max !== undefined ? { priceMax: args.price_max } : {}),
        ...(args.sort ? { sort: args.sort } : {}),
        limit: Math.min(Math.max(args.limit ?? 6, 1), 10),
      };
      const key = JSON.stringify([selected.map((a) => a.id), query]);
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttl) return hit.value;

      const { offers, failed } = await searchAll(selected, query, ctx.signal);
      const value = JSON.stringify({
        offers: offers.map(compact),
        unavailable: failed,
        ...(offers.length === 0 && failed.length > 0
          ? {
              note: "Ни одна площадка не отдала результаты. Скажи владельцу, какие недоступны и почему; защиту не обходи.",
            }
          : {}),
      });
      if (offers.length > 0) cache.set(key, { at: now(), value });
      return value;
    },
  };
}

function compact(offer: ProductOffer): Record<string, unknown> {
  return {
    marketplace: offer.marketplace,
    title: offer.title,
    price: offer.price,
    oldPrice: offer.oldPrice,
    rating: offer.rating,
    reviews: offer.reviews,
    url: offer.url,
    fetchedAt: offer.fetchedAt,
  };
}
