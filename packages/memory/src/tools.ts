import type { Tool, ToolContext } from "@burmalda/core";
import type { LongTermMemory } from "./longTerm";
import type { ProfileStore } from "./profile";

const owner = (ctx: ToolContext) => ctx.ownerId ?? "owner";

/** Инструменты памяти для агента. */
export function memoryTools(
  longTerm: LongTermMemory,
  profile: ProfileStore,
): Tool[] {
  const remember: Tool<{ text: string; tags?: string[] }> = {
    name: "remember",
    description:
      "Сохранить в долговременную память устойчивый факт о владельце или его делах (предпочтения, люди, договорённости, планы). " +
      "Один факт — одно короткое самодостаточное утверждение от третьего лица, например «Владелец пьёт кофе без сахара». " +
      "Не сохраняй разовые мелочи и то, что уже есть в профиле.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Факт одним предложением" },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Темы: еда, учёба, работа, здоровье…",
        },
      },
      required: ["text"],
    },
    async execute(args, ctx) {
      const { fact, updated } = await longTerm.remember(
        owner(ctx),
        args.text,
        args.tags ?? [],
      );
      return `${updated ? "Обновлено" : "Запомнено"} (id ${fact.id}): ${fact.text}`;
    },
  };

  const recall: Tool<{ query: string; limit?: number }> = {
    name: "recall_memory",
    description:
      "Найти в долговременной памяти факты о владельце по смыслу и по словам. Используй, когда ответ может зависеть от прошлых разговоров, " +
      "предпочтений или договорённостей, которых нет в текущем контексте.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Что ищем, своими словами" },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      },
      required: ["query"],
    },
    async execute(args, ctx) {
      const facts = await longTerm.recall(
        owner(ctx),
        args.query,
        args.limit ?? 5,
      );
      if (facts.length === 0) return "В памяти ничего не нашлось.";
      return facts
        .map((f) => `- ${f.text} (id ${f.id}, ${f.createdAt.slice(0, 10)})`)
        .join("\n");
    },
  };

  const forget: Tool<{ id: string }> = {
    name: "forget_memory",
    description:
      "Удалить факт из долговременной памяти по id (когда владелец просит забыть или факт устарел).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    async execute(args, ctx) {
      return (await longTerm.forget(owner(ctx), args.id))
        ? "Удалено."
        : "Факт с таким id не найден.";
    },
  };

  const setProfile: Tool<{ key: string; value?: string }> = {
    name: "set_profile",
    description:
      "Записать точное поле профиля владельца (name, city, timezone, university_group, language и т. п.). " +
      "Пустое value — удалить поле. Профиль всегда виден в системном промпте.",
    parameters: {
      type: "object",
      properties: { key: { type: "string" }, value: { type: "string" } },
      required: ["key"],
    },
    async execute(args, ctx) {
      if (!args.value) {
        await profile.delete(owner(ctx), args.key);
        return `Поле ${args.key} удалено.`;
      }
      await profile.set(owner(ctx), args.key, args.value);
      return `Профиль: ${args.key} = ${args.value}`;
    },
  };

  return [remember, recall, forget, setProfile] as Tool[];
}
