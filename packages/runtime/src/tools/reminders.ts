import type { Tool } from "@burmalda/core";
import type { ReminderStore } from "@burmalda/queue";

export function reminderTools(store: ReminderStore): Tool[] {
  const create: Tool<{ text: string; at: string; cron?: string }> = {
    name: "create_reminder",
    description:
      "Напоминание владельцу. at — ISO 8601 с часовым поясом (Asia/Tomsk, +07:00). cron — 5 полей, если напоминание повторное. Срабатывание придёт в ту же сессию.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "О чём напомнить" },
        at: { type: "string", description: "Когда, ISO 8601 с поясом" },
        cron: {
          type: "string",
          description: "Необязательно: 5 полей cron, пояс Asia/Tomsk",
        },
      },
      required: ["text", "at"],
    },
    async execute(args, ctx) {
      const text = required(args.text, "text");
      const at = required(args.at, "at");
      const created = await store.create({
        text,
        at,
        cron: args.cron?.trim() || undefined,
        sessionId: ctx.sessionId,
      });
      return JSON.stringify({
        id: created.id,
        text: created.text,
        nextAt: created.nextAt,
      });
    },
  };

  const list: Tool = {
    name: "list_reminders",
    description: "Список напоминаний этой сессии: id, text, nextAt, cron.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const items = await store.list(ctx.sessionId);
      return JSON.stringify(
        items.map((item) => ({
          id: item.id,
          text: item.text,
          nextAt: item.nextAt,
          ...(item.cron ? { cron: item.cron } : {}),
        })),
      );
    },
  };

  const cancel: Tool<{ id: string }> = {
    name: "cancel_reminder",
    description: "Отменить напоминание по id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async execute(args, ctx) {
      await store.cancel(ctx.sessionId, required(args.id, "id"));
      return "Отменено";
    },
  };

  return [create, list, cancel];
}

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} должен быть непустой строкой`);
  }
  return value.trim();
}
