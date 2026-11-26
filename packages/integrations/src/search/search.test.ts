import { test } from "node:test";
import assert from "node:assert/strict";
import { htmlToText } from "./html";
import { fetchPage } from "./fetchPage";
import { searchWeb } from "./searxng";
import { assertPublicHttpUrl, isPrivateIp } from "./ssrf";

test("частные адреса и localhost закрыты", async () => {
  assert.equal(isPrivateIp("10.1.2.3"), true);
  assert.equal(isPrivateIp("8.8.8.8"), false);
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIp("2001:4860:4860::8888"), false);
  assert.equal(isPrivateIp("2002:7f00:1::"), true);
  assert.equal(isPrivateIp("2002:0808:0808::"), false);
  assert.equal(isPrivateIp("2001:0:4136:e378:8000:63bf:3fff:fdd2"), true);
  assert.equal(isPrivateIp("fc00::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  await assert.rejects(
    () => assertPublicHttpUrl("http://127.0.0.1/"),
    /закрыт/,
  );
  await assert.rejects(() => assertPublicHttpUrl("file:///etc/passwd"), /http/);
  await assert.rejects(
    () =>
      assertPublicHttpUrl("https://example.test/", async () => ["10.0.0.5"]),
    /Частные/,
  );
  const url = await assertPublicHttpUrl("https://example.test/a", async () => [
    "8.8.8.8",
  ]);
  assert.equal(url.hostname, "example.test");
});

test("htmlToText убирает скрипты и теги", () => {
  const page = htmlToText(
    "<html><head><title>Заголовок</title><style>x{}</style></head><body><script>alert(1)</script><p>Привет&amp;мир</p></body></html>",
  );
  assert.equal(page.title, "Заголовок");
  assert.match(page.text, /Привет&мир|Привет&amp;мир|Привет&мир/);
  assert.equal(page.text.includes("alert"), false);
  assert.equal(page.text.includes("<p>"), false);
});

test("searchWeb читает JSON SearXNG", async () => {
  const hits = await searchWeb({
    baseUrl: "http://searx.local",
    query: "бурмалда",
    limit: 1,
    fetchImpl: async (input) => {
      const url = String(input);
      assert.match(url, /format=json/);
      assert.match(url, /q=/);
      return new Response(
        JSON.stringify({
          results: [
            { title: "Один", url: "https://a.example", content: "сниппет" },
            { title: "Два", url: "https://b.example", content: "нет" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  assert.deepEqual(hits, [
    { title: "Один", url: "https://a.example", snippet: "сниппет" },
  ]);
});

test("fetchPage не идёт по редиректу на частный адрес", async () => {
  await assert.rejects(
    () =>
      fetchPage("https://example.test/start", {
        resolveHost: async () => ["8.8.8.8"],
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: "http://127.0.0.1/secret" },
          }),
      }),
    /закрыт/,
  );
});

test("fetchPage возвращает текст и итоговый URL", async () => {
  const page = await fetchPage("https://example.test/page", {
    resolveHost: async () => ["8.8.8.8"],
    maxChars: 20,
    fetchImpl: async () =>
      new Response("<title>T</title><p>длинный текст страницы</p>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(page.title, "T");
  assert.equal(page.url, "https://example.test/page");
  assert.ok(page.text.length <= 20);
});
