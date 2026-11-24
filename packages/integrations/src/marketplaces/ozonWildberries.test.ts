import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixtureRenderer } from "./browser";
import {
  buildOzonSearchUrl,
  createOzonAdapter,
  ozonBlock,
  parseOzonSearch,
} from "./ozon";
import {
  buildWildberriesSearchUrl,
  createWildberriesAdapter,
  parseWildberriesSearch,
  wildberriesBlock,
} from "./wildberries";
import { createYandexMarketAdapter, yandexMarketBlock } from "./yandexMarket";
import { MarketplaceBlockedError } from "./types";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const at = new Date("2026-11-24T10:00:00Z");

test("WB: разбор карточек (синтетическая фикстура по разметке)", () => {
  const offers = parseWildberriesSearch(
    fixture("wildberriesSearch.html"),
    undefined,
    at,
  );
  assert.equal(offers.length, 2);
  assert.deepEqual(offers[0], {
    marketplace: "wildberries",
    externalId: "111111111",
    title: "Acme / Наушники беспроводные TWS",
    url: "https://www.wildberries.ru/catalog/111111111/detail.aspx",
    price: 1290,
    oldPrice: 3490,
    rating: 4.7,
    reviews: 12345,
    seller: "Acme",
    fetchedAt: at.toISOString(),
  });
  assert.equal(offers[1]!.price, 499);
  assert.equal(offers[1]!.rating, undefined);
});

test("Ozon: разбор плиток (синтетическая фикстура по структуре)", () => {
  const offers = parseOzonSearch(fixture("ozonSearch.html"), undefined, at);
  assert.equal(offers.length, 2);
  assert.deepEqual(offers[0], {
    marketplace: "ozon",
    externalId: "1234567890",
    title: "Наушники беспроводные Acme Pro, белые",
    url: "https://www.ozon.ru/product/naushniki-besprovodnye-acme-1234567890/",
    price: 1299,
    oldPrice: 2999,
    rating: 4.8,
    reviews: 1024,
    fetchedAt: at.toISOString(),
  });
  assert.equal(offers[1]!.price, 599);
  assert.ok(!offers[1]!.url.includes("?"));
});

test("URL поиска WB и Ozon: фильтры цены и сортировка", () => {
  const wb = new URL(
    buildWildberriesSearchUrl({
      text: "наушники",
      priceMax: 2000,
      sort: "price_asc",
    }),
  );
  assert.equal(wb.searchParams.get("search"), "наушники");
  assert.equal(wb.searchParams.get("sort"), "priceup");
  assert.equal(wb.searchParams.get("priceU"), "0;200000");
  const oz = new URL(
    buildOzonSearchUrl({ text: "наушники", priceMin: 500, sort: "price_desc" }),
  );
  assert.equal(oz.searchParams.get("text"), "наушники");
  assert.equal(oz.searchParams.get("sorting"), "price_desc");
  assert.match(oz.searchParams.get("currency_price") ?? "", /^500\.000;/);
});

// Страницы защиты сняты вживую 2026-11-24 через infra/browser (IP в них заменён на 0.0.0.0).
test("реальные страницы защиты распознаются как блокировка", async () => {
  const wb = fixture("wildberriesBlocked.html");
  assert.equal(wildberriesBlock({ status: 498, html: wb }), "captcha");
  assert.equal(wildberriesBlock({ status: 200, html: wb }), "captcha");
  assert.equal(
    wildberriesBlock({ status: 200, html: fixture("wildberriesSearch.html") }),
    undefined,
  );

  const oz = fixture("ozonBlocked.html");
  assert.equal(
    ozonBlock({
      status: 403,
      finalUrl: "https://www.ozon.ru/search/?text=x&__rr=1",
      html: oz,
    }),
    "captcha",
  );
  assert.equal(
    ozonBlock({
      status: 200,
      finalUrl: "https://www.ozon.ru/search/?text=x",
      html: oz,
    }),
    "captcha",
  );
  assert.equal(
    ozonBlock({
      status: 200,
      finalUrl: "https://www.ozon.ru/search/?text=x",
      html: fixture("ozonSearch.html"),
    }),
    undefined,
  );

  const ym = fixture("yandexMarketBlocked.html");
  assert.equal(
    yandexMarketBlock({
      status: 200,
      finalUrl: "https://market.yandex.ru/search",
      html: ym,
    }),
    "forbidden",
  );

  for (const [adapter, html, status, reason] of [
    [
      createWildberriesAdapter({
        renderer: fixtureRenderer(wb, { status: 498 }),
      }),
      wb,
      498,
      "captcha",
    ],
    [
      createOzonAdapter({ renderer: fixtureRenderer(oz, { status: 403 }) }),
      oz,
      403,
      "captcha",
    ],
    [
      createYandexMarketAdapter({
        renderer: fixtureRenderer(ym, { status: 403 }),
      }),
      ym,
      403,
      "forbidden",
    ],
  ] as const) {
    void html;
    void status;
    await assert.rejects(adapter.search({ text: "x" }), (e: Error) => {
      assert.ok(e instanceof MarketplaceBlockedError);
      assert.equal(e.reason, reason);
      return true;
    });
  }
});

test("адаптеры WB/Ozon: одна страница на запрос, фильтр и лимит поверх выдачи", async () => {
  const renderer = fixtureRenderer(fixture("wildberriesSearch.html"));
  const wb = createWildberriesAdapter({ renderer, now: () => at });
  const cheap = await wb.search({ text: "наушники", priceMax: 1000 });
  assert.deepEqual(
    cheap.map((o) => o.externalId),
    ["222222222"],
  );
  assert.equal(renderer.urls.length, 1);

  const oz = createOzonAdapter({
    renderer: fixtureRenderer(fixture("ozonSearch.html")),
    now: () => at,
  });
  const sorted = await oz.search({ text: "x", sort: "price_asc", limit: 1 });
  assert.equal(sorted.length, 1);
  assert.equal(sorted[0]!.price, 599);
});
