import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTIME_DEFAULT_GROUP_ID,
  eventsInRange,
  InTimeSource,
  parseInTimeSchedule,
  tomskDateParam,
} from "./intime";

test("день для InTime считается в Томске, не в UTC", () => {
  assert.equal(
    tomskDateParam(new Date("2026-11-26T17:00:00.000Z")),
    "2026-11-27",
  );
  assert.equal(
    tomskDateParam(new Date("2026-11-26T16:59:00.000Z")),
    "2026-11-26",
  );
});

test("фикстура расписания 972302: 14 пар, 08:45 Томска", async () => {
  const raw = await readFile(
    new URL("./fixtures/intime-972302-2026-11-23.json", import.meta.url),
    "utf8",
  );
  const events = parseInTimeSchedule(JSON.parse(raw));
  assert.equal(events.length, 14);
  const first = events[0];
  assert.equal(first?.title, "Профессиональный английский язык");
  assert.equal(first?.start, "2026-11-23T01:45:00.000Z");
  assert.equal(first?.end, "2026-11-23T03:20:00.000Z");
  assert.match(first?.location ?? "", /227/);
  assert.equal(first?.source, "TSU.InTime");
  assert.equal(INTIME_DEFAULT_GROUP_ID, "ac6b8bef-2c83-11ee-8151-005056bc52bb");
});

test("InTime: в ответ попадают только события внутри интервала", () => {
  const events = eventsInRange(
    [
      {
        id: "mon",
        title: "Понедельник",
        start: "2026-11-23T01:45:00.000Z",
        end: "2026-11-23T03:20:00.000Z",
        source: "TSU.InTime",
      },
      {
        id: "next",
        title: "Следующий понедельник",
        start: "2026-11-30T01:45:00.000Z",
        end: "2026-11-30T03:20:00.000Z",
        source: "TSU.InTime",
      },
    ],
    new Date("2026-11-23T00:00:00+07:00"),
    new Date("2026-11-30T00:00:00+07:00"),
  );
  assert.deepEqual(
    events.map((event) => event.id),
    ["mon"],
  );
});

test("InTime: битый ответ — понятная ошибка", () => {
  assert.throws(() => parseInTimeSchedule({}), /нет grid/);
});

test(
  "InTime живьём: расписание группы по умолчанию",
  { skip: process.env.TEST_INTIME !== "1" && "TEST_INTIME не задан" },
  async () => {
    const source = new InTimeSource(INTIME_DEFAULT_GROUP_ID);
    const events = await source.getEvents(
      new Date("2026-11-23T00:00:00+07:00"),
      new Date("2026-11-30T00:00:00+07:00"),
    );
    assert.ok(events.length > 0);
    assert.equal(events[0]?.source, "TSU.InTime");
  },
);
