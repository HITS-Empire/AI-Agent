import { readSkillBody } from "../skills/skillMd";
import { asString } from "./args";
import type { Tool } from "./types";

/** Ленивая загрузка тела SKILL.md. Метаданные уже лежат в system prompt. */
export function loadSkillTool(dirs: string[]): Tool<{ name: string }> {
  return {
    name: "load_skill",
    description:
      "Загрузить полный текст навыка по имени из списка в системном промпте и дальше следовать ему. " +
      "Возвращает тело SKILL.md без frontmatter.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Имя навыка, например web-search или calendar",
        },
      },
      required: ["name"],
    },
    async execute(args) {
      return readSkillBody(dirs, asString(args.name, "name").trim());
    },
  };
}
