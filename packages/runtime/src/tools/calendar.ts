import type { Tool } from "@burmalda/core";
import type {
  CalendarEvent,
  ExternalScheduleSource,
  PersonalCalendar,
} from "@burmalda/integrations";

export interface CalendarToolSources {
  personal?: PersonalCalendar;
  external?: ExternalScheduleSource;
}

export function calendarTools(sources: CalendarToolSources): Tool[] {
  const list: Tool<{ from: string; to: string }> = {
    name: "calendar_list",
    description:
      "События личного календаря и внешнее расписание между from и to (ISO 8601 с часовым поясом). Личные id начинаются с personal:, чужие — только чтение.",
    parameters: rangeSchema("Начало диапазона", "Конец диапазона"),
    async execute(args) {
      const { from, to } = range(args.from, args.to);
      const events: CalendarEvent[] = [];
      if (sources.personal) {
        for (const event of await sources.personal.listEvents(from, to)) {
          events.push({ ...event, id: prefixed(event.id, "personal") });
        }
      }
      if (sources.external) {
        const prefix = sources.external.name.includes("InTime")
          ? "intime"
          : "ext";
        for (const event of await sources.external.getEvents(from, to)) {
          events.push({ ...event, id: prefixed(event.id, prefix) });
        }
      }
      events.sort((a, b) => a.start.localeCompare(b.start));
      return JSON.stringify(events);
    },
  };

  const add: Tool<{
    title: string;
    start: string;
    end?: string;
    location?: string;
    description?: string;
  }> = {
    name: "calendar_add",
    description:
      "Записать событие в личный календарь. start и end — ISO 8601 с часовым поясом. Без end событие длится час. Пояс владельца — Asia/Tomsk.",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "Начало, ISO 8601 с поясом" },
        end: { type: "string", description: "Конец; по умолчанию через час" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["title", "start"],
    },
    async execute(args) {
      const personal = needPersonal(sources.personal);
      const title = required(args.title, "title");
      const start = zoned(args.start, "start");
      const end = args.end?.trim()
        ? zoned(args.end, "end")
        : new Date(start.getTime() + 60 * 60 * 1000);
      if (end <= start)
        throw new Error("Конец события должен быть позже начала");
      const created = await personal.createEvent({
        title,
        start: start.toISOString(),
        end: end.toISOString(),
        location: args.location?.trim() || undefined,
        description: args.description?.trim() || undefined,
      });
      return JSON.stringify({
        ...created,
        id: prefixed(created.id, "personal"),
      });
    },
  };

  const remove: Tool<{ id: string }> = {
    name: "calendar_delete",
    description:
      "Удалить событие личного календаря по id. События InTime и других внешних календарей только для чтения.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    dangerous: true,
    async execute(args) {
      const id = required(args.id, "id");
      if (id.startsWith("intime:") || id.startsWith("ext:")) {
        throw new Error("только чтение");
      }
      const personal = needPersonal(sources.personal);
      const uid = id.startsWith("personal:")
        ? id.slice("personal:".length)
        : id;
      await personal.deleteEvent(uid);
      return "Удалено";
    },
  };

  return [list, add, remove];
}

function rangeSchema(from: string, to: string): Tool["parameters"] {
  return {
    type: "object",
    properties: {
      from: { type: "string", description: from },
      to: { type: "string", description: to },
    },
    required: ["from", "to"],
  };
}

function range(fromRaw: string, toRaw: string): { from: Date; to: Date } {
  const from = zoned(fromRaw, "from");
  const to = zoned(toRaw, "to");
  if (to <= from) throw new Error("Конец диапазона должен быть позже начала");
  return { from, to };
}

function zoned(value: unknown, name: string): Date {
  const text = required(value, name);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) {
    throw new Error(`${name}: нужно ISO 8601 с часовым поясом`);
  }
  const date = new Date(text);
  if (Number.isNaN(date.getTime()))
    throw new Error(`${name}: некорректная дата`);
  return date;
}

function prefixed(id: string, prefix: string): string {
  return id.startsWith(`${prefix}:`) ? id : `${prefix}:${id}`;
}

function needPersonal(
  personal: PersonalCalendar | undefined,
): PersonalCalendar {
  if (!personal) {
    throw new Error(
      "Личный календарь не настроен: задайте CALDAV_URL, CALDAV_USERNAME и CALDAV_PASSWORD",
    );
  }
  return personal;
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} должен быть непустой строкой`);
  }
  return value.trim();
}
