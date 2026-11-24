import { notImplemented } from "@burmalda/shared";
import type {
  MarketplaceAdapter,
  MarketplaceId,
  ProductOffer,
  ProductQuery,
} from "./types";

import { createYandexMarketAdapter } from "./yandexMarket";

export * from "./types";
export * from "./yandexMarket";
export * from "./curlFetch";

/**
 * Яндекс Маркет готов (обычный HTTP, см. yandexMarket.ts).
 * TODO(B): адаптеры Ozon и Wildberries. Простые HTTP-запросы к их поиску блокируются антиботом
 * (WB — 403, Ozon — 307), поэтому чтение идёт через браузер в песочнице (см. docs/PLAN.md,
 * «Маркетплейсы»). Без входа в аккаунт, с паузами и кэшем; на капче — MarketplaceBlockedError.
 */
export function createMarketplaceAdapter(
  id: MarketplaceId,
): MarketplaceAdapter {
  if (id === "yandex_market") return createYandexMarketAdapter();
  return notImplemented(`адаптер маркетплейса ${id}`);
}

/** Параллельный поиск по нескольким площадкам: недоступная площадка не роняет остальные. */
export async function searchAll(
  adapters: MarketplaceAdapter[],
  query: ProductQuery,
  signal?: AbortSignal,
): Promise<{
  offers: ProductOffer[];
  failed: Array<{ marketplace: MarketplaceId; error: string }>;
}> {
  const results = await Promise.allSettled(
    adapters.map((adapter) => adapter.search(query, signal)),
  );
  const offers: ProductOffer[] = [];
  const failed: Array<{ marketplace: MarketplaceId; error: string }> = [];

  results.forEach((result, i) => {
    const marketplace = adapters[i]!.id;
    if (result.status === "fulfilled") offers.push(...result.value);
    else
      failed.push({
        marketplace,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      });
  });

  return { offers, failed };
}
