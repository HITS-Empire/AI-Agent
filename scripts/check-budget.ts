// Живая проверка бюджетов шлюза: временный ключ с бюджетом $0.0005 → первый запрос проходит,
// следующие шлюз отклоняет (budget_exceeded); ключ удаляется. Ключи не печатаются.
// Запуск: corepack pnpm@10.34.9 exec tsx --env-file=.env scripts/check-budget.ts
import process from "node:process";
import { GatewayClient, GatewayError } from "../packages/core/src/index";

const base = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
const master = process.env.LITELLM_MASTER_KEY;
const model = process.env.BURMALDA_MODEL_FAST ?? "burmalda-fast";
if (!master) throw new Error("нужен LITELLM_MASTER_KEY в .env");

async function admin<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${master}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

const { key } = await admin<{ key: string }>("/key/generate", {
  key_alias: `budget-check-${Date.now()}`,
  models: [model],
  max_budget: 0.0005,
});
const client = new GatewayClient({ baseUrl: base, apiKey: key, maxRetries: 0 });
let rejected = 0;
try {
  for (let i = 1; i <= 3; i++) {
    try {
      const r = await client.chat({
        model,
        messages: [{ role: "user", content: "Ответь: ок" }],
      });
      console.log(`${i}: ok, стоимость $${r.meta?.costUsd ?? 0}`);
    } catch (error) {
      if (!(error instanceof GatewayError) || error.code !== "budget_exceeded")
        throw error;
      rejected++;
      console.log(`${i}: отклонено шлюзом (${error.status} ${error.code})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} finally {
  await admin("/key/delete", { keys: [key] });
}
if (rejected === 0) {
  console.error("Бюджет не сработал");
  process.exit(1);
}
console.log("Бюджет соблюдается: запросы сверх лимита отклонены");
