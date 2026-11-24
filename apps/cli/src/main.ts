import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { BANNER, PROJECT_NAME, loadConfig } from "@burmalda/shared";
import {
  GatewayClient,
  ToolRegistry,
  runAgent,
  type ChatMessage,
} from "@burmalda/core";

/**
 * CLI «бурмалды».
 * Сейчас: режим --direct — цикл агента прямо в процессе (для проверки шлюза и ядра, вехa M1).
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

  const llm = new GatewayClient({
    baseUrl: config.gateway.baseUrl,
    apiKey: config.gateway.apiKey,
  });
  const tools = new ToolRegistry();
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `Ты — ${PROJECT_NAME}, персональный ассистент владельца. Отвечай по-русски, кратко.`,
    },
  ];
  const sessionId = `cli-${randomUUID()}`;
  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (;;) {
      const text = (await rl.question(`${PROJECT_NAME}> `)).trim();
      if (!text) continue;
      if (text === "/exit") break;

      messages.push({ role: "user", content: text });
      const result = await runAgent({
        llm,
        model: config.gateway.models.main,
        tools,
        messages,
        ctx: {
          sessionId,
          taskId: randomUUID(),
          workspaceRoot: config.sandbox.workspaceDir,
          requestApproval: async (question) =>
            (await rl.question(`${question} [y/N] `)).trim().toLowerCase() ===
            "y",
        },
        onEvent: (event) => {
          if (event.type === "tool_call") stdout.write(`  ↳ ${event.name}\n`);
        },
      });
      stdout.write(
        `\n${result.finalText}\n\n  [${result.usage.totalTokens} токенов]\n\n`,
      );
    }
  } finally {
    rl.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
