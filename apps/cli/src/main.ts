import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import {
  BANNER,
  PROJECT_NAME,
  createLogger,
  loadConfig,
} from "@burmalda/shared";
import { createRuntimeFromConfig, type RuntimeBundle } from "@burmalda/runtime";

/**
 * CLI «бурмалды».
 * --direct — рантайм агента прямо в процессе: та же память, сессия и инструменты, что у worker.
 * TODO(B): основной режим — задача в общую очередь + подписка на events:<sessionId>,
 * чтобы разговор из Telegram продолжался здесь (общая сессия владельца).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const direct = process.argv.includes("--direct");

  stdout.write(
    `${BANNER}\n  ${PROJECT_NAME} · CLI · ${direct ? "direct" : "queue"} mode\n\n`,
  );

  if (!direct) {
    stdout.write("Режим очереди ещё не готов. Запусти с --direct.\n");
    return;
  }

  // логи в stderr и только предупреждения, чтобы не мешать диалогу
  const log = createLogger("cli", process.env.LOG_LEVEL_CLI ?? "warn");
  const ownerId = process.env.BURMALDA_OWNER_ID ?? "owner";
  const sessionId = process.env.BURMALDA_SESSION_ID ?? `${ownerId}:main`;
  const bundle = await createRuntimeFromConfig(config, log, {
    serviceName: "burmalda-cli",
    root: resolve(import.meta.dirname, "../../.."),
  });
  const rl = createInterface({ input: stdin, output: stdout });
  stdout.write(`  сессия ${sessionId} · /usage — расход · /exit — выход\n\n`);

  try {
    for (;;) {
      const text = (await rl.question(`${PROJECT_NAME}> `)).trim();
      if (!text) continue;
      if (text === "/exit") break;
      if (text === "/usage") {
        stdout.write(`${await usageReport(bundle)}\n\n`);
        continue;
      }

      try {
        const result = await bundle.runtime.run(
          { text, sessionId, ownerId, channel: "cli" },
          {
            onEvent: (event) => {
              if (event.type === "tool_call")
                stdout.write(`  ↳ ${event.name} ${event.argsPreview}\n`);
              if (event.type === "tool_result" && !event.ok)
                stdout.write(`  ✗ ${event.name}\n`);
              if (event.type === "status" && event.text.startsWith("контекст"))
                stdout.write(`  · ${event.text}\n`);
            },
            requestApproval: async (question) =>
              (await rl.question(`  ? ${question} [y/N] `))
                .trim()
                .toLowerCase() === "y",
          },
        );
        const u = result.usage;
        stdout.write(
          `\n${result.text}\n\n  [${u.totalTokens} ток. (${u.promptTokens}→${u.completionTokens}, кэш ${u.cachedTokens}) · $${u.costUsd.toFixed(4)}]\n\n`,
        );
      } catch (error) {
        stdout.write(
          `\n  ошибка: ${error instanceof Error ? error.message : String(error)}\n\n`,
        );
      }
    }
  } finally {
    rl.close();
    await bundle.shutdown();
  }
}

async function usageReport(bundle: RuntimeBundle): Promise<string> {
  const lines: string[] = [];
  try {
    const key = await bundle.gateway.keyInfo();
    lines.push(
      `  ключ шлюза: потрачено $${key.spend.toFixed(4)}${key.maxBudget !== null ? ` из $${key.maxBudget}` : ""}${key.budgetResetAt ? `, сброс ${key.budgetResetAt}` : ""}`,
    );
  } catch (error) {
    lines.push(`  ключ шлюза: недоступно (${String(error)})`);
  }
  const daily = await bundle.usageStore.daily(7);
  for (const row of daily) {
    lines.push(
      `  ${row.day} ${row.model}: ${row.calls} выз., ${row.promptTokens}→${row.completionTokens} ток., $${row.costUsd.toFixed(4)}`,
    );
  }
  if (daily.length === 0) lines.push("  за 7 дней расхода нет");
  return lines.join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
