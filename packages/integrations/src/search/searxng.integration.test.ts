import { test } from "node:test";
import assert from "node:assert/strict";
import { searchWeb } from "./searxng";

const baseUrl =
  process.env.TEST_SEARXNG_URL ??
  process.env.SEARXNG_URL ??
  "http://127.0.0.1:8080";

test("SearXNG из compose отвечает JSON", async (t) => {
  try {
    const probe = await fetch(`${baseUrl}/healthz`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!probe.ok) {
      t.skip(`SearXNG HTTP ${probe.status}`);
      return;
    }
  } catch {
    t.skip("SearXNG не запущен");
    return;
  }
  const hits = await searchWeb({ baseUrl, query: "example", limit: 3 });
  assert.ok(Array.isArray(hits));
  if (hits[0]) {
    assert.equal(typeof hits[0].url, "string");
    assert.equal(typeof hits[0].title, "string");
  }
});
