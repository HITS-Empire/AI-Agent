import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { PROJECT_NAME, createLogger, loadConfig } from "@burmalda/shared";
import {
  AGENT_QUEUE,
  EventBus,
  createAgentQueue,
  createAgentWorker,
  createReminderWorker,
  enqueueAgentTask,
} from "@burmalda/queue";
import { createRuntimeFromConfig } from "@burmalda/runtime";
import { stopAllSandboxes } from "@burmalda/sandbox";

/**
 * Worker «бурмалды»: единственный процесс, где крутится цикл агента.
 * Задача из AGENT_QUEUE → рантайм (память, system prompt, compaction, инструменты) → AgentEvent в events:<sessionId>.
 * Напоминания из REMINDERS_QUEUE возвращаются задачей channel=scheduler в ту же сессию.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("worker", config.logLevel);
  const ownerId = process.env.BURMALDA_OWNER_ID ?? "owner";

  const bundle = await createRuntimeFromConfig(config, log, {
    serviceName: "burmalda-worker",
    root: resolve(import.meta.dirname, "../../.."),
  });
  const bus = new EventBus(config.redisUrl);
  const agentQueue = createAgentQueue(config.redisUrl);
  const reminders = createReminderWorker(config.redisUrl, async (reminder) => {
    await enqueueAgentTask(agentQueue, {
      sessionId: reminder.sessionId,
      channel: "scheduler",
      text: `Напоминание: ${reminder.text}`,
    });
    log.info(
      { reminderId: reminder.id, sessionId: reminder.sessionId },
      "напоминание",
    );
  });

  const worker = createAgentWorker(config.redisUrl, async (task) => {
    log.info(
      { taskId: task.taskId, sessionId: task.sessionId, channel: task.channel },
      "задача",
    );
    const result = await bundle.runtime.run(
      { ...task, ownerId },
      {
        onEvent: (event) => {
          void bus
            .publish(task.sessionId, event)
            .catch((error: unknown) =>
              log.warn(
                { error: String(error) },
                "не удалось опубликовать событие",
              ),
            );
        },
        requestApproval: async (text) => {
          const requestId = randomUUID();
          await bus.publish(task.sessionId, {
            type: "approval_required",
            taskId: task.taskId,
            requestId,
            text,
          });
          return bus.waitApproval(requestId);
        },
      },
    );
    return { text: result.text, usage: result.usage };
  });

  worker.on("failed", (job, error) =>
    log.error(
      { taskId: job?.data.taskId, error: error.message },
      "задача упала",
    ),
  );
  log.info(
    { queue: AGENT_QUEUE, shellMode: config.sandbox.shellMode },
    `${PROJECT_NAME} worker запущен`,
  );

  const stop = async () => {
    log.info("останавливаюсь");
    await reminders.close();
    await worker.close();
    await agentQueue.close();
    await stopAllSandboxes().catch((error: unknown) =>
      log.warn({ error: String(error) }, "не удалось остановить песочницы"),
    );
    await bus.close();
    await bundle.shutdown();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
