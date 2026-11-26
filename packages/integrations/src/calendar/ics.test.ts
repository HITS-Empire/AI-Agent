import { test } from "node:test";
import assert from "node:assert/strict";
import { formatEventIcs, overlaps, parseIcs } from "./icsParse";
import {
  createCalDavCalendar,
  extractCalendarData,
  extractHrefs,
} from "./caldav";
import { IcsSource } from "./ics";

const SAMPLE = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT",
  "UID:lesson-1",
  "DTSTART;TZID=Asia/Tomsk:20261127T150000",
  "DTEND;TZID=Asia/Tomsk:20261127T160000",
  "SUMMARY:Встреча\\, важная",
  "LOCATION:ауд. 1",
  "DESCRIPTION:перенос строки",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

test("ICS: Томск, экранирование и попадание в диапазон", () => {
  const [event] = parseIcs(SAMPLE);
  assert.ok(event);
  assert.equal(event.title, "Встреча, важная");
  assert.equal(event.location, "ауд. 1");
  assert.equal(event.start.toISOString(), "2026-11-27T08:00:00.000Z");
  assert.equal(
    overlaps(
      event,
      new Date("2026-11-27T07:00:00.000Z"),
      new Date("2026-11-27T09:00:00.000Z"),
    ),
    true,
  );
  assert.equal(
    overlaps(
      event,
      new Date("2026-11-27T10:00:00.000Z"),
      new Date("2026-11-27T11:00:00.000Z"),
    ),
    false,
  );
  const written = formatEventIcs({
    uid: event.uid,
    title: event.title,
    start: event.start.toISOString(),
    end: event.end.toISOString(),
  });
  const [again] = parseIcs(written);
  assert.equal(again?.start.toISOString(), event.start.toISOString());
});

test("ICS: UTC и свёрнутая строка", () => {
  const text =
    "BEGIN:VEVENT\r\nUID:a\r\nSUMMARY:длин\r\n ное\r\nDTSTART:20261126T000000Z\r\nEND:VEVENT";
  const [event] = parseIcs(text);
  assert.equal(event?.title, "длинное");
  assert.equal(event?.start.toISOString(), "2026-11-26T00:00:00.000Z");
});

test("extractCalendarData достаёт экранированный ICS", () => {
  const xml =
    "<D:multistatus><C:calendar-data>BEGIN:VCALENDAR&#10;BEGIN:VEVENT&#10;UID:z&#10;SUMMARY:A&amp;B&#10;DTSTART:20261126T000000Z&#10;END:VEVENT</C:calendar-data></D:multistatus>";
  const [ics] = extractCalendarData(xml);
  assert.equal(parseIcs(ics ?? "")[0]?.title, "A&B");
});

test("IcsSource фильтрует фид по диапазону", async () => {
  const source = new IcsSource(
    "https://calendar.example/feed.ics",
    async () => new Response(SAMPLE, { status: 200 }),
    async () => ["93.184.216.34"],
  );
  const inside = await source.getEvents(
    new Date("2026-11-27T00:00:00.000Z"),
    new Date("2026-11-28T00:00:00.000Z"),
  );
  assert.equal(inside.length, 1);
  assert.equal(inside[0]?.source, "iCal");
  const outside = await source.getEvents(
    new Date("2026-11-28T00:00:00.000Z"),
    new Date("2026-11-29T00:00:00.000Z"),
  );
  assert.equal(outside.length, 0);
});

test("CalDAV: если PROPFIND без тела, событие читается GET-ом", async () => {
  const ics = formatEventIcs({
    uid: "uid-1",
    title: "Встреча",
    start: "2026-11-27T08:00:00.000Z",
    end: "2026-11-27T09:00:00.000Z",
  });
  const xml =
    "<multistatus><response><href>/owner/personal/</href></response><response><href>/owner/personal/uid-1.ics</href><propstat><prop><calendar-data /></prop><status>HTTP/1.1 404 Not Found</status></propstat></response></multistatus>";
  assert.deepEqual(extractHrefs(xml), ["/owner/personal/uid-1.ics"]);
  const calendar = createCalDavCalendar({
    url: "https://cal.example/owner/personal/",
    username: "owner",
    password: "secret",
    fetchImpl: async (input, init) => {
      const method = init?.method ?? "GET";
      const href = String(input);
      if (method === "PROPFIND" && href.endsWith("/")) {
        return new Response(xml, { status: 207 });
      }
      if (method === "GET" && href.endsWith("uid-1.ics")) {
        return new Response(ics, { status: 200 });
      }
      return new Response("", { status: 500 });
    },
  });
  const events = await calendar.listEvents(
    new Date("2026-11-27T00:00:00.000Z"),
    new Date("2026-11-28T00:00:00.000Z"),
  );
  assert.equal(events.length, 1);
  assert.equal(events[0]?.title, "Встреча");
});

test("IcsSource не открывает частный адрес", async () => {
  const source = new IcsSource(
    "http://127.0.0.1/feed.ics",
    async () => new Response("BEGIN:VCALENDAR", { status: 200 }),
  );
  await assert.rejects(
    () => source.getEvents(new Date(), new Date(Date.now() + 1000)),
    /закрыт/,
  );
});
