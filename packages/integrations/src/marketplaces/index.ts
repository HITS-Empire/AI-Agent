import { notImplemented } from "@burmalda/shared";
import type {
  MarketplaceAdapter,
  MarketplaceId,
  ProductOffer,
  ProductQuery,
} from "./types";

export * from "./types";

/**
 * TODO(B): адаптеры Ozon, Wildberries, Яндекс Маркета. Простые HTTP-запросы к поиску площадок
 * блокируются антиботом (проверено 24.11.2026: WB — 403, Ozon — 307, Маркет — 302 на капчу),
 * поэтому чтение идёт через браузер в песочнице (см. docs/PLAN.md, «Маркетплейсы»).
 * Без входа в аккаунт, с паузами и кэшем; на капче — MarketplaceBlockedError, обходить её нельзя.
 */
export function createMarketplaceAdapter(
  id: MarketplaceId,
): MarketplaceAdapter {
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
