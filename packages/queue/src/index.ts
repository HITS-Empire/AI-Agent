import type { AgentEvent, AgentTask } from "@burmalda/shared";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";

/**
 * Общая очередь задач для всех интерфейсов. Telegram и CLI кладут задачи сюда,
 * worker выполняет и публикует AgentEvent в канал events:<sessionId>.
 */
export const AGENT_QUEUE = "burmalda-agent";
export const REMINDERS_QUEUE = "burmalda-reminders";

export const eventsChannel = (sessionId: string): string =>
  `events:${sessionId}`;

/** BullMQ принимает опции ioredis, а не URL — разбираем сами. */
export function redisConnection(redisUrl: string): {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
} {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : undefined,
  };
}

export function createAgentQueue(
  redisUrl: string,
  name = AGENT_QUEUE,
): Queue<AgentTask> {
  return new Queue<AgentTask>(name, {
    connection: redisConnection(redisUrl),
  });
}

export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

export function parseEvent(raw: string): AgentEvent {
  return JSON.parse(raw) as AgentEvent;
}

/** Worker очереди агента. Порядок задач внутри сессии обеспечивает рантайм. */
export function createAgentWorker(
  redisUrl: string,
  handler: (task: AgentTask, job: Job<AgentTask>) => Promise<unknown>,
  concurrency = 4,
  name = AGENT_QUEUE,
): Worker<AgentTask> {
  return new Worker<AgentTask>(name, (job) => handler(job.data, job), {
    connection: { ...redisConnection(redisUrl), maxRetriesPerRequest: null },
    concurrency,
  });
}

/** Публикация событий задачи в events:<sessionId>. */
export class EventBus {
  private readonly pub: Redis;
  private readonly subs: Redis[] = [];

  constructor(private readonly redisUrl: string) {
    this.pub = new Redis(redisUrl, { lazyConnect: false });
  }

  async publish(sessionId: string, event: AgentEvent): Promise<void> {
    await this.pub.publish(eventsChannel(sessionId), serializeEvent(event));
  }

  /** Подписка на события сессии (для Telegram/CLI). Возвращает функцию отписки. */
  async subscribe(
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
  ): Promise<() => Promise<void>> {
    const sub = new Redis(this.redisUrl);
    this.subs.push(sub);
    sub.on("message", (_channel: string, raw: string) =>
      onEvent(parseEvent(raw)),
    );
    await sub.subscribe(eventsChannel(sessionId));
    return async () => {
      await sub.quit().catch(() => undefined);
    };
  }

  /**
   * Подтверждение опасного действия: worker публикует approval_required и ждёт ответа
   * интерфейса в списке approval:<requestId> (BLPOP), по таймауту — отказ.
   */
  async waitApproval(requestId: string, timeoutSec = 300): Promise<boolean> {
    const client = this.pub.duplicate();
    try {
      const reply = await client.blpop(approvalKey(requestId), timeoutSec);
      return reply?.[1] === "yes";
    } finally {
      client.disconnect();
    }
  }

  async answerApproval(requestId: string, approved: boolean): Promise<void> {
    await this.pub
      .multi()
      .rpush(approvalKey(requestId), approved ? "yes" : "no")
      .expire(approvalKey(requestId), 600)
      .exec();
  }

  async close(): Promise<void> {
    await Promise.all(
      [this.pub, ...this.subs].map((c) => c.quit().catch(() => undefined)),
    );
  }
}

export const approvalKey = (requestId: string): string =>
  `approval:${requestId}`;

export { enqueueAgentTask, ownerSession, reduceTurn } from "./submit";
export type { TurnState } from "./submit";
export {
  createBullReminderStore,
  createMemoryReminderStore,
  createReminderWorker,
  parseZonedIso,
  planReminder,
} from "./reminders";
export type {
  ReminderDraft,
  ReminderRecord,
  ReminderService,
  ReminderStore,
} from "./reminders";
