import { test } from "node:test";
import assert from "node:assert/strict";
import { GatewayClient, GatewayError } from "./gatewayClient";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const okChat = {
  id: "x",
  model: "burmalda-main",
  choices: [
    {
      index: 0,
      finish_reason: "stop",
      message: { role: "assistant", content: "привет" },
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
};

test("chat: шлёт запрос в шлюз с виртуальным ключом и читает стоимость из заголовка", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = new GatewayClient({
    baseUrl: "http://gw:4000/",
    apiKey: "sk-test",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return jsonResponse(okChat, 200, {
        "x-litellm-response-cost": "0.00042",
      });
    },
  });

  const response = await client.chat({
    model: "burmalda-main",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(calls[0]!.url, "http://gw:4000/v1/chat/completions");
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>).authorization,
    "Bearer sk-test",
  );
  assert.equal(response.choices[0]!.message.content, "привет");
  assert.equal(response.meta?.costUsd, 0.00042);
  assert.equal(response.meta?.attempts, 1);
});

test("chat: ретраит 503 и 429, затем отдаёт ответ", async () => {
  let n = 0;
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    retryBaseMs: 1,
    fetchImpl: async () => {
      n++;
      if (n === 1) return new Response("busy", { status: 503 });
      if (n === 2) return new Response("rate", { status: 429 });
      return jsonResponse(okChat);
    },
  });
  const response = await client.chat({ model: "m", messages: [] });
  assert.equal(n, 3);
  assert.equal(response.meta?.attempts, 3);
});

test("chat: 400 не ретраится и превращается в GatewayError", async () => {
  let n = 0;
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    retryBaseMs: 1,
    fetchImpl: async () => {
      n++;
      return new Response('{"error":"bad model"}', { status: 400 });
    },
  });
  await assert.rejects(
    client.chat({ model: "m", messages: [] }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.status, 400);
      return true;
    },
  );
  assert.equal(n, 1);
});

test("chat: сетевая ошибка ретраится до лимита", async () => {
  let n = 0;
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    retryBaseMs: 1,
    maxRetries: 2,
    fetchImpl: async () => {
      n++;
      throw new TypeError("fetch failed");
    },
  });
  await assert.rejects(client.chat({ model: "m", messages: [] }), TypeError);
  assert.equal(n, 3);
});

test("embed: возвращает векторы в порядке входа", async () => {
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://gw/v1/embeddings");
      assert.deepEqual(JSON.parse(String(init!.body)), {
        model: "burmalda-embed",
        input: ["a", "b"],
      });
      return jsonResponse({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      });
    },
  });
  assert.deepEqual(await client.embed(["a", "b"], "burmalda-embed"), [
    [1],
    [2],
  ]);
});

test("keyInfo: читает расход и бюджет ключа", async () => {
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    fetchImpl: async () =>
      jsonResponse({
        info: { spend: 1.5, max_budget: 20, models: ["burmalda-main"] },
      }),
  });
  const info = await client.keyInfo();
  assert.equal(info.spend, 1.5);
  assert.equal(info.maxBudget, 20);
});

test("превышение бюджета (422 budget_exceeded) — понятная ошибка без повторов", async () => {
  let calls = 0;
  const client = new GatewayClient({
    baseUrl: "http://gw",
    apiKey: "k",
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          error: {
            message:
              "Budget has been exceeded! Current cost: 0.0008, Max budget: 0.0005",
            type: "budget_exceeded",
            code: "400",
          },
        }),
        { status: 422 },
      );
    },
  });
  await assert.rejects(
    client.chat({
      model: "burmalda-fast",
      messages: [{ role: "user", content: "x" }],
    }),
    (error: unknown) => {
      assert.ok(error instanceof GatewayError);
      assert.equal(error.code, "budget_exceeded");
      assert.equal(error.retryable, false);
      assert.match(error.message, /Бюджет ключа шлюза исчерпан/);
      return true;
    },
  );
  assert.equal(calls, 1);
});
