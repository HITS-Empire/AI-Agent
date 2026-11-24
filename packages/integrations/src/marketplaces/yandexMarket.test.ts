import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildSearchUrl,
  createYandexMarketAdapter,
  parseYandexMarketSearch,
} from "./yandexMarket";
import { MarketplaceBlockedError } from "./types";
import { fixtureRenderer, RenderRateLimitedError } from "./browser";

const fixture = readFileSync(
  new URL("./fixtures/yandexMarketSearch.html", import.meta.url),
  "utf8",
);
const at = new Date("2026-11-24T10:00:00Z");

test("разбор выдачи: цена со скидкой, старая цена, рейтинг, чистая ссылка", () => {
  const offers = parseYandexMarketSearch(
    fixture,
    "https://market.yandex.ru",
    at,
  );
  assert.equal(offers.length, 3);
  const first = offers[0]!;
  assert.equal(first.marketplace, "yandex_market");
  assert.equal(first.externalId, "6354394191");
  assert.equal(first.price, 562);
  assert.equal(first.oldPrice, 6999);
  assert.ok(first.title.length > 5);
  assert.match(
    first.url,
    /^https:\/\/market\.yandex\.ru\/card\/[^?]+\?do-waremd5=rBdegvvHzR6mkiLHSY8LRw$/,
  );
  assert.ok(!first.url.includes("cpc"));
  assert.equal(first.fetchedAt, at.toISOString());
  for (const o of offers) assert.ok(o.price > 0);
});

test("URL поиска: фильтры цены и сортировка", () => {
  const url = new URL(
    buildSearchUrl({
      text: "наушники",
      priceMin: 1000,
      priceMax: 3000,
      sort: "price_asc",
    }),
  );
  assert.equal(url.searchParams.get("text"), "наушники");
  assert.equal(url.searchParams.get("pricefrom"), "1000");
  assert.equal(url.searchParams.get("priceto"), "3000");
  assert.equal(url.searchParams.get("how"), "aprice");
});

test("адаптер: фильтр по цене, сортировка и лимит поверх выдачи", async () => {
  const adapter = createYandexMarketAdapter({
    renderer: fixtureRenderer(fixture),
    now: () => at,
  });
  const offers = await adapter.search({
    text: "x",
    sort: "price_desc",
    limit: 2,
  });
  assert.equal(offers.length, 2);
  assert.ok(offers[0]!.price >= offers[1]!.price);
  const cheap = await adapter.search({ text: "x", priceMax: 600 });
  assert.ok(cheap.every((o) => o.price <= 600));
});

test("капча, 403 и лимит частоты — MarketplaceBlockedError, без обхода", async () => {
  const redirect = createYandexMarketAdapter({
    renderer: fixtureRenderer("<html></html>", {
      finalUrl: "https://market.yandex.ru/showcaptcha?x",
    }),
  });
  await assert.rejects(redirect.search({ text: "x" }), (e: Error) => {
    assert.ok(e instanceof MarketplaceBlockedError);
    assert.match(e.message, /captcha/);
    return true;
  });
  const page = createYandexMarketAdapter({
    renderer: fixtureRenderer(
      "<html><form action='/checkcaptcha'></form></html>",
    ),
  });
  await assert.rejects(page.search({ text: "x" }), /captcha/);
  const forbidden = createYandexMarketAdapter({
    renderer: fixtureRenderer("", { status: 403 }),
  });
  await assert.rejects(forbidden.search({ text: "x" }), /forbidden/);
  const limited = createYandexMarketAdapter({
    renderer: {
      render: async () => {
        throw new RenderRateLimitedError(5000);
      },
    },
  });
  await assert.rejects(limited.search({ text: "x" }), /rate_limited/);
});
