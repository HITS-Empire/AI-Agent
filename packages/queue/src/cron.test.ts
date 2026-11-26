import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCron, nextCronRun } from "./cron";
import { createMemoryReminderStore, planReminder } from "./reminders";

test("cron: пять полей и ближайшие 09:00 Томска", () => {
  assert.throws(() => assertCron("* * * *"), /5 полей/);
  assert.throws(() => assertCron("60 * * * *"), /вне/);
  const next = nextCronRun("0 9 * * *", new Date("2026-11-26T01:00:00.000Z"));
  assert.equal(next.toISOString(), "2026-11-26T02:00:00.000Z");
  const monday = nextCronRun(
    "30 8 * * 1",
    new Date("2026-11-26T01:00:00.000Z"),
  );
  assert.equal(monday.toISOString(), "2026-11-30T01:30:00.000Z");
});

test("planReminder требует пояс и отказывается от прошлого", () => {
  assert.throws(
    () =>
      planReminder({ text: "вода", at: "2026-11-27T15:00:00", sessionId: "s" }),
    /пояс/,
  );
  const plan = planReminder(
    { text: "вода", at: "2026-11-27T15:00:00+07:00", sessionId: "s" },
    new Date("2026-11-27T07:00:00.000Z"),
  );
  assert.equal(plan.nextAt, "2026-11-27T08:00:00.000Z");
  assert.throws(
    () =>
      planReminder(
        { text: "вода", at: "2026-11-27T15:00:00+07:00", sessionId: "s" },
        new Date("2026-11-27T09:00:00.000Z"),
      ),
    /прошло/,
  );
});

test("память напоминаний: создать, список, отмена", async () => {
  const store = createMemoryReminderStore(
    () => new Date("2026-11-26T00:00:00.000Z"),
  );
  const created = await store.create({
    text: "вода",
    at: "2026-11-26T10:00:00+07:00",
    sessionId: "owner:main",
  });
  assert.equal(created.text, "вода");
  const listed = await store.list("owner:main");
  assert.equal(listed.length, 1);
  await store.cancel("owner:main", created.id);
  assert.equal((await store.list("owner:main")).length, 0);
  await assert.rejects(() => store.cancel("other", created.id), /не найдено/);
});
