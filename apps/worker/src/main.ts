import { PROJECT_NAME, createLogger, loadConfig } from "@burmalda/shared";
import { AGENT_QUEUE } from "@burmalda/queue";

/**
 * Worker «бурмалды»: единственный процесс, где крутится цикл агента.
 * TODO(A/B): BullMQ Worker на AGENT_QUEUE → загрузка сессии из памяти → AGENTS.md/скиллы/факты в system →
 * runAgent с compaction → сохранение → AgentEvent в events:<sessionId>. Плюс планировщик напоминаний.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("worker", config.logLevel);
  log.info(
    { queue: AGENT_QUEUE, shellMode: config.sandbox.shellMode },
    `${PROJECT_NAME} worker: каркас`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
