import type { AgentEvent, AgentTask } from "@burmalda/shared";
import { Queue } from "bullmq";

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

export function createAgentQueue(redisUrl: string): Queue<AgentTask> {
  return new Queue<AgentTask>(AGENT_QUEUE, {
    connection: redisConnection(redisUrl),
  });
}

export function serializeEvent(event: AgentEvent): string {
  return JSON.stringify(event);
}

export function parseEvent(raw: string): AgentEvent {
  return JSON.parse(raw) as AgentEvent;
}
