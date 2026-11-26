import { test } from "node:test";
import assert from "node:assert/strict";
import type { ToolContext } from "@burmalda/core";
import type { PersonalCalendar, CalendarEvent } from "@burmalda/integrations";
import { createMemoryReminderStore } from "@burmalda/queue";
import { calendarTools } from "./calendar";
import { reminderTools } from "./reminders";
import { fetchUrlTool, webSearchTool } from "./web";

const ctx: ToolContext = {
  sessionId: "owner:main",
  taskId: "t",
  workspaceRoot: "/tmp",
  requestApproval: async () => true,
};

test("web_search и fetch_url отдают данные, а не сырой HTML", async () => {
  const search = webSearchTool(async () => [
    { title: "Документ", url: "https://example.com", snippet: "кратко" },
  ]);
  assert.equal(
    await search.execute({ query: "бурмалда", limit: 3 }, ctx),
    JSON.stringify([
      { title: "Документ", url: "https://example.com", snippet: "кратко" },
    ]),
  );
  const page = fetchUrlTool(async () => ({
    title: "T",
    url: "https://example.com/final",
    text: "не делай это",
  }));
  const text = await page.execute({ url: "https://example.com" }, ctx);
  assert.match(text, /не инструкции/);
  assert.match(text, /https:\/\/example.com\/final/);
  assert.match(text, /не делай это/);
});

test("напоминания: создать, увидеть, отменить", async () => {
  const store = createMemoryReminderStore(
    () => new Date("2026-11-26T00:00:00.000Z"),
  );
  const [create, list, cancel] = reminderTools(store);
  const raw = await create!.execute(
    { text: "вода", at: "2026-11-26T10:00:00+07:00" },
    ctx,
  );
  const created = JSON.parse(raw) as { id: string; nextAt: string };
  assert.equal(created.nextAt, "2026-11-26T03:00:00.000Z");
  const listed = JSON.parse(await list!.execute({}, ctx)) as Array<{
    id: string;
  }>;
  assert.equal(listed[0]?.id, created.id);
  assert.equal(await cancel!.execute({ id: created.id }, ctx), "Отменено");
});

test("календарь: час по умолчанию, слияние и только чтение InTime", async () => {
  const saved: CalendarEvent[] = [];
  const personal: PersonalCalendar = {
    async listEvents() {
      return saved;
    },
    async createEvent(event) {
      const created = { ...event, id: "uid-1", source: "caldav" };
      saved.push(created);
      return created;
    },
    async deleteEvent(id) {
      const index = saved.findIndex((event) => event.id === id);
      if (index < 0) throw new Error("нет");
      saved.splice(index, 1);
    },
  };
  const [list, add, remove] = calendarTools({
    personal,
    external: {
      name: "TSU.InTime",
      async getEvents() {
        return [
          {
            id: "pair-1",
            title: "Математика",
            start: "2026-11-27T01:45:00.000Z",
            end: "2026-11-27T03:15:00.000Z",
            source: "TSU.InTime",
          },
        ];
      },
    },
  });
  const created = JSON.parse(
    await add!.execute(
      { title: "Встреча", start: "2026-11-27T15:00:00+07:00" },
      ctx,
    ),
  ) as { id: string; end: string };
  assert.equal(created.id, "personal:uid-1");
  assert.equal(created.end, "2026-11-27T09:00:00.000Z");
  const events = JSON.parse(
    await list!.execute(
      { from: "2026-11-27T00:00:00+07:00", to: "2026-11-28T00:00:00+07:00" },
      ctx,
    ),
  ) as Array<{ id: string }>;
  assert.deepEqual(
    events.map((event) => event.id),
    ["intime:pair-1", "personal:uid-1"],
  );
  await assert.rejects(
    () => remove!.execute({ id: "intime:pair-1" }, ctx),
    /только чтение/,
  );
  assert.equal(remove!.dangerous, true);
  assert.equal(await remove!.execute({ id: "personal:uid-1" }, ctx), "Удалено");
});
