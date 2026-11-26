import { test } from "node:test";
import assert from "node:assert/strict";
import { createCalDavCalendar } from "./caldav";

const url = process.env.TEST_CALDAV_URL ?? process.env.CALDAV_URL;
const username =
  process.env.TEST_CALDAV_USERNAME ?? process.env.CALDAV_USERNAME ?? "owner";
const password =
  process.env.TEST_CALDAV_PASSWORD ?? process.env.CALDAV_PASSWORD;

test("Radicale: создать, прочитать и удалить событие", async (t) => {
  if (!url || !password) {
    t.skip("нет CALDAV_URL/CALDAV_PASSWORD");
    return;
  }
  try {
    // У Radicale неудачный вход ждёт auth.delay (1 с). Короткий таймаут принимал живой сервер за молчание.
    const probe = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (probe.status >= 500) {
      t.skip(`Radicale HTTP ${probe.status}`);
      return;
    }
  } catch {
    t.skip("Radicale не отвечает");
    return;
  }

  const calendar = createCalDavCalendar({ url, username, password });
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const created = await calendar.createEvent({
    title: "бурмалда-тест",
    start: start.toISOString(),
    end: end.toISOString(),
  });
  try {
    const listed = await calendar.listEvents(
      new Date(start.getTime() - 60_000),
      new Date(end.getTime() + 60_000),
    );
    assert.equal(
      listed.some(
        (event) => event.id === created.id && event.title === "бурмалда-тест",
      ),
      true,
    );
  } finally {
    await calendar.deleteEvent(created.id);
  }
});
