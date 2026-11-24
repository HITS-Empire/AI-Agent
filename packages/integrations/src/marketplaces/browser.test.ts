import { test } from "node:test";
import assert from "node:assert/strict";
import { createBrowserRenderer, RenderRateLimitedError } from "./browser";

test("клиент браузера: POST /render и разбор ответа", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const renderer = createBrowserRenderer({
    baseUrl: "http://browser:3100/",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({
        status: 200,
        finalUrl: "https://x/",
        title: "t",
        html: "<p>",
      });
    },
  });
  const page = await renderer.render("https://x/", { waitFor: ".a" });
  assert.equal(calls[0]!.url, "http://browser:3100/render");
  assert.deepEqual(calls[0]!.body, {
    url: "https://x/",
    waitFor: ".a",
    timeoutMs: 30000,
  });
  assert.equal(page.html, "<p>");
});

test("клиент браузера: 429 сервиса → RenderRateLimitedError, 403 → ошибка", async () => {
  const limited = createBrowserRenderer({
    fetchImpl: async () =>
      Response.json(
        { error: "rate limited", retryAfterMs: 7000 },
        { status: 429 },
      ),
  });
  await assert.rejects(limited.render("https://x/"), (e: Error) => {
    assert.ok(e instanceof RenderRateLimitedError);
    assert.equal(e.retryAfterMs, 7000);
    return true;
  });
  const denied = createBrowserRenderer({
    fetchImpl: async () =>
      Response.json({ error: "host not allowed: x" }, { status: 403 }),
  });
  await assert.rejects(denied.render("https://x/"), /host not allowed/);
});
