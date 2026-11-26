import { randomUUID } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { stdin, stdout } from "node:process";
import { resolve } from "node:path";
import {
  BANNER,
  PROJECT_NAME,
  createLogger,
  loadConfig,
  type AgentEvent,
} from "@burmalda/shared";
import { createRuntimeFromConfig, type RuntimeBundle } from "@burmalda/runtime";
import {
  EventBus,
  createAgentQueue,
  enqueueAgentTask,
  ownerSession,
  reduceTurn,
  type TurnState,
} from "@burmalda/queue";

/**
 * CLI «бурмалды».
 * Без флагов — задача в общую очередь и подписка на events:<sessionId> (нужен worker).
 * --direct — рантайм агента прямо в процессе, та же сессия владельца.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const direct = process.argv.includes("--direct");
  const { ownerId, sessionId } = ownerSession();

  stdout.write(
    `${BANNER}\n  ${PROJECT_NAME} · CLI · ${direct ? "direct" : "queue"} mode\n\n`,
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = lineReader(rl);

  if (!direct) {
    try {
      await runQueue(config.redisUrl, sessionId, ask);
    } finally {
      rl.close();
    }
    return;
  }

  // логи в stderr и только предупреждения, чтобы не мешать диалогу
  const log = createLogger("cli", process.env.LOG_LEVEL_CLI ?? "warn", {
    stderr: true,
  });
  const bundle = await createRuntimeFromConfig(config, log, {
    serviceName: "burmalda-cli",
    root: resolve(import.meta.dirname, "../../.."),
  });
  stdout.write(`  сессия ${sessionId} · /usage — расход · /exit — выход\n\n`);

  try {
    for (;;) {
      const line = await ask(`${PROJECT_NAME}> `);
      if (line === null) break;
      const text = line.trim();
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
              (await ask(`  ? ${question} [y/N] `))?.trim().toLowerCase() ===
              "y",
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

/**
 * Режим очереди: задача уходит worker-у, ответ и подтверждения приходят по Redis.
 * Сессия общая с Telegram.
 */
async function runQueue(
  redisUrl: string,
  sessionId: string,
  ask: (prompt: string) => Promise<string | null>,
): Promise<void> {
  const queue = createAgentQueue(redisUrl);
  const bus = new EventBus(redisUrl);
  stdout.write(
    `  сессия ${sessionId} · очередь · нужен worker · /exit — выход\n\n`,
  );

  let active: { taskId: string } | undefined;
  let state: TurnState | undefined;
  let settle: ((state: TurnState) => void) | undefined;

  const unsubscribe = await bus.subscribe(sessionId, (event) => {
    if (!active || event.taskId !== active.taskId || !state || !settle) return;
    if (event.type === "tool_call") {
      stdout.write(`  ↳ ${event.name} ${event.argsPreview}\n`);
    }
    if (event.type === "tool_result" && !event.ok) {
      stdout.write(`  ✗ ${event.name}\n`);
    }
    if (event.type === "status" && event.text.startsWith("контекст")) {
      stdout.write(`  · ${event.text}\n`);
    }
    if (event.type === "approval_required") {
      void answerApproval(bus, ask, event);
    }
    state = reduceTurn(state, event);
    if (state.status !== "running") settle(state);
  });

  try {
    for (;;) {
      const line = await ask(`${PROJECT_NAME}> `);
      if (line === null) break;
      const text = line.trim();
      if (!text) continue;
      if (text === "/exit") break;
      if (text === "/usage") {
        stdout.write(
          "  расход — в режиме --direct (/usage) или в LiteLLM UI\n\n",
        );
        continue;
      }
      try {
        const taskId = randomUUID();
        state = { taskId, text: "", status: "running" };
        active = { taskId };
        const result = await new Promise<TurnState>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("worker не ответил")),
            10 * 60 * 1000,
          );
          settle = (next) => {
            clearTimeout(timer);
            resolve(next);
          };
          void enqueueAgentTask(queue, {
            sessionId,
            channel: "cli",
            text,
            taskId,
          }).catch((error: unknown) => {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
        if (result.status === "error") {
          stdout.write(`\n  ошибка: ${result.error ?? "неизвестно"}\n\n`);
        } else {
          stdout.write(`\n${result.text}\n\n`);
        }
      } catch (error) {
        stdout.write(
          `\n  ошибка: ${error instanceof Error ? error.message : String(error)}\n\n`,
        );
      } finally {
        active = undefined;
        settle = undefined;
      }
    }
  } finally {
    await unsubscribe();
    await bus.close();
    await queue.close();
  }
}

async function answerApproval(
  bus: EventBus,
  ask: (prompt: string) => Promise<string | null>,
  event: Extract<AgentEvent, { type: "approval_required" }>,
): Promise<void> {
  const answer = await ask(`  ? ${event.text} [y/N] `);
  await bus.answerApproval(
    event.requestId,
    answer?.trim().toLowerCase() === "y",
  );
}

/**
 * Очередь строк ввода: строки, пришедшие, пока агент думает (или из pipe), не теряются.
 * null — ввод закончился.
 */
function lineReader(rl: Interface): (prompt: string) => Promise<string | null> {
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    for (const waiter of waiters.splice(0)) waiter(null);
  });
  return (prompt) => {
    const ready = lines.shift();
    if (ready !== undefined) {
      stdout.write(`${prompt}${ready}\n`);
      return Promise.resolve(ready);
    }
    if (closed) return Promise.resolve(null);
    stdout.write(prompt);
    return new Promise((resolve) => waiters.push(resolve));
  };
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
