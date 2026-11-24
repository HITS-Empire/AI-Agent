import { test } from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "@burmalda/core";
import {
  MarketplaceBlockedError,
  type MarketplaceAdapter,
} from "@burmalda/integrations";
import { marketplaceSearchTool } from "./marketplace";

const ctx = {
  sessionId: "s",
  taskId: "t",
  workspaceRoot: "/",
  requestApproval: async () => true,
};

test("marketplace_search: сводит площадки, недоступную помечает, кэширует", async () => {
  let calls = 0;
  const ym: MarketplaceAdapter = {
    id: "yandex_market",
    async search(query) {
      calls++;
      assert.equal(query.priceMax, 3000);
      assert.equal(query.limit, 6);
      return [
        {
          marketplace: "yandex_market",
          externalId: "1",
          title: "Наушники",
          url: "https://market.yandex.ru/card/x/1",
          price: 1990,
          oldPrice: 2990,
          rating: 4.8,
          reviews: 120,
          seller: "shop:1",
          fetchedAt: "2026-11-24T10:00:00.000Z",
        },
      ];
    },
  };
  const wb: MarketplaceAdapter = {
    id: "wildberries",
    async search() {
      throw new MarketplaceBlockedError("wildberries", "captcha");
    },
  };
  const tools = new ToolRegistry();
  tools.register(marketplaceSearchTool([ym, wb]));

  const args = JSON.stringify({ query: "наушники", price_max: 3000 });
  const first = await tools.call("marketplace_search", args, ctx);
  assert.ok(first.ok);
  const parsed = JSON.parse(first.content) as {
    offers: Array<Record<string, unknown>>;
    unavailable: Array<{ marketplace: string; error: string }>;
  };
  assert.equal(parsed.offers[0]!.price, 1990);
  assert.equal(parsed.offers[0]!.seller, undefined);
  assert.equal(parsed.unavailable[0]!.marketplace, "wildberries");
  assert.match(parsed.unavailable[0]!.error, /captcha/);

  await tools.call("marketplace_search", args, ctx);
  assert.equal(calls, 1);

  const onlyYm = await tools.call(
    "marketplace_search",
    JSON.stringify({
      query: "наушники",
      price_max: 3000,
      marketplaces: ["yandex_market"],
    }),
    ctx,
  );
  assert.equal(JSON.parse(onlyYm.content).unavailable.length, 0);
});
