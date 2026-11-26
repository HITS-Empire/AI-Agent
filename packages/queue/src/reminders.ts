import { randomUUID } from "node:crypto";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { assertCron, nextCronRun } from "./cron";
import { redisConnection, REMINDERS_QUEUE } from "./index";

export interface ReminderRecord {
  id: string;
  text: string;
  nextAt: string;
  cron?: string;
  sessionId: string;
  repeatKey?: string;
}

export interface ReminderDraft {
  text: string;
  at: string;
  cron?: string;
  sessionId: string;
}

export interface ReminderStore {
  create(input: ReminderDraft): Promise<ReminderRecord>;
  list(sessionId: string): Promise<ReminderRecord[]>;
  cancel(sessionId: string, id: string): Promise<void>;
}

interface ReminderJob {
  sessionId: string;
  id: string;
}

export function parseZonedIso(value: string): Date {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(value.trim())) {
    throw new Error(
      "Время нужно в ISO 8601 с часовым поясом, например 2026-11-27T15:00:00+07:00",
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Некорректная дата");
  return date;
}

export function planReminder(
  input: ReminderDraft,
  now = new Date(),
): { cron?: string; nextAt: string } {
  const cron = input.cron?.trim();
  if (cron) {
    const normalized = assertCron(cron);
    return {
      cron: normalized,
      nextAt: nextCronRun(normalized, now).toISOString(),
    };
  }
  const at = parseZonedIso(input.at);
  if (at.getTime() < now.getTime() - 5_000) throw new Error("Время уже прошло");
  return { nextAt: at.toISOString() };
}

/** Память процесса: юнит-тесты инструментов, без Redis. */
export function createMemoryReminderStore(
  now: () => Date = () => new Date(),
): ReminderStore {
  const items = new Map<string, ReminderRecord>();
  return {
    async create(input) {
      const id = randomUUID();
      const plan = planReminder(input, now());
      const record: ReminderRecord = {
        id,
        text: input.text,
        sessionId: input.sessionId,
        nextAt: plan.nextAt,
        cron: plan.cron,
      };
      items.set(id, record);
      return record;
    },
    async list(sessionId) {
      return [...items.values()].filter((item) => item.sessionId === sessionId);
    },
    async cancel(sessionId, id) {
      const item = items.get(id);
      if (!item || item.sessionId !== sessionId)
        throw new Error("Напоминание не найдено");
      items.delete(id);
    },
  };
}

export interface ReminderService {
  store: ReminderStore;
  close(): Promise<void>;
}

/**
 * Напоминания в Redis: одноразовые — delayed job, повтор — cron Asia/Tomsk.
 * Запись о напоминании лежит в хеше и переживает перезапуск worker.
 */
export function createBullReminderStore(
  redisUrl: string,
  queueName = REMINDERS_QUEUE,
): ReminderService {
  const redis = new Redis({
    ...redisConnection(redisUrl),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 1500,
  });
  const queue = new Queue<ReminderJob>(queueName, {
    connection: redisConnection(redisUrl),
  });

  const connect = async (): Promise<void> => {
    if (redis.status === "wait") {
      try {
        await redis.connect();
      } catch (error) {
        throw new Error(
          `Напоминания недоступны: нет Redis (${String(error)})`,
          {
            cause: error,
          },
        );
      }
    }
  };

  const store: ReminderStore = {
    async create(input) {
      await connect();
      const plan = planReminder(input);
      const id = randomUUID();
      const record: ReminderRecord = {
        id,
        text: input.text,
        sessionId: input.sessionId,
        nextAt: plan.nextAt,
        cron: plan.cron,
      };
      if (plan.cron) {
        await queue.upsertJobScheduler(
          id,
          { pattern: plan.cron, tz: "Asia/Tomsk" },
          { name: "fire", data: { sessionId: input.sessionId, id } },
        );
        const scheduler = await queue.getJobScheduler(id);
        record.repeatKey = id;
        record.nextAt = scheduler?.next
          ? new Date(scheduler.next).toISOString()
          : record.nextAt;
      } else {
        const delay = Math.max(0, new Date(plan.nextAt).getTime() - Date.now());
        await queue.add(
          "fire",
          { sessionId: input.sessionId, id },
          {
            jobId: id,
            delay,
            attempts: 3,
            removeOnComplete: true,
            removeOnFail: 50,
          },
        );
      }
      await redis.hset(hashKey(input.sessionId), id, JSON.stringify(record));
      return record;
    },

    async list(sessionId) {
      await connect();
      const all = await redis.hgetall(hashKey(sessionId));
      return Object.values(all).map((raw) => JSON.parse(raw) as ReminderRecord);
    },

    async cancel(sessionId, id) {
      await connect();
      const raw = await redis.hget(hashKey(sessionId), id);
      if (!raw) throw new Error("Напоминание не найдено");
      const record = JSON.parse(raw) as ReminderRecord;
      if (record.cron) await queue.removeJobScheduler(id);
      const job = await queue.getJob(id);
      await job?.remove();
      await redis.hdel(hashKey(sessionId), id);
    },
  };

  return {
    store,
    async close() {
      await queue.close();
      await redis.quit().catch(() => undefined);
    },
  };
}

/** Слушает очередь только worker, чтобы напоминание не сработало дважды. */
export function createReminderWorker(
  redisUrl: string,
  deliver: (reminder: ReminderRecord) => Promise<void>,
  queueName = REMINDERS_QUEUE,
): Worker<ReminderJob> {
  const redis = new Redis({
    ...redisConnection(redisUrl),
    maxRetriesPerRequest: null,
  });
  const worker = new Worker<ReminderJob>(
    queueName,
    async (job: Job<ReminderJob>) => {
      const raw = await redis.hget(hashKey(job.data.sessionId), job.data.id);
      if (!raw) return;
      const record = JSON.parse(raw) as ReminderRecord;
      await deliver(record);
      if (!record.cron)
        await redis.hdel(hashKey(job.data.sessionId), job.data.id);
    },
    {
      connection: { ...redisConnection(redisUrl), maxRetriesPerRequest: null },
    },
  );
  worker.on("closed", () => {
    void redis.quit().catch(() => undefined);
  });
  return worker;
}

function hashKey(sessionId: string): string {
  return `burmalda:reminders:${sessionId}`;
}
