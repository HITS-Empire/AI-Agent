import { randomUUID } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createBullReminderStore, createReminderWorker } from "./reminders";

const url = process.env.TEST_REDIS_URL;

test(
  "одноразовое напоминание срабатывает из Redis и снимается",
  { skip: !url && "нет TEST_REDIS_URL" },
  async () => {
    const name = `burmalda-reminders-${randomUUID()}`;
    const sessionId = `test:${randomUUID()}`;
    const service = createBullReminderStore(url!, name);
    const delivered: string[] = [];
    const worker = createReminderWorker(
      url!,
      async (reminder) => {
        delivered.push(reminder.text);
      },
      name,
    );
    try {
      await service.store.create({
        text: "вода",
        at: new Date(Date.now() + 400).toISOString(),
        sessionId,
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && delivered.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.deepEqual(delivered, ["вода"]);
      assert.equal((await service.store.list(sessionId)).length, 0);
    } finally {
      await worker.close();
      await service.close();
    }
  },
);
