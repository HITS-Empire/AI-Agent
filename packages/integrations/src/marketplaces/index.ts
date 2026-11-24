import type {
  MarketplaceAdapter,
  MarketplaceId,
  ProductOffer,
  ProductQuery,
} from "./types";

import type { PageRenderer } from "./browser";
import { createBrowserRenderer } from "./browser";
import { createOzonAdapter } from "./ozon";
import { createWildberriesAdapter } from "./wildberries";
import { createYandexMarketAdapter } from "./yandexMarket";

export * from "./types";
export * from "./browser";
export * from "./yandexMarket";
export * from "./ozon";
export * from "./wildberries";

/**
 * Все три площадки читаются одинаково: публичная страница поиска без входа в аккаунт открывается
 * в headless Chromium отдельного контейнера (infra/browser, сервис `browser` в docker-compose).
 * Сервис пускает только эти домены, не чаще одной страницы на сайт за BROWSER_MIN_INTERVAL_MS;
 * инструмент кэширует результат. Капча/антибот/403 → MarketplaceBlockedError, без обходов.
 */
export function createMarketplaceAdapter(
  id: MarketplaceId,
  renderer: PageRenderer = createBrowserRenderer(),
): MarketplaceAdapter {
  if (id === "yandex_market") return createYandexMarketAdapter({ renderer });
  if (id === "ozon") return createOzonAdapter({ renderer });
  return createWildberriesAdapter({ renderer });
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
