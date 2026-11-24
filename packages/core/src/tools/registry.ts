import type { ToolSpec } from "../llm/types";
import type { Tool, ToolContext } from "./types";

/** Максимум символов результата инструмента, который уходит в контекст модели. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

/** Имя функции у OpenAI-совместимых API: [a-zA-Z0-9_-], до 64 символов. */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export interface ToolOutcome {
  ok: boolean;
  content: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register<Args>(tool: Tool<Args>): void {
    if (!TOOL_NAME_RE.test(tool.name)) {
      throw new Error(`Недопустимое имя инструмента: ${tool.name}`);
    }
    if (this.tools.has(tool.name)) {
      throw new Error(`Инструмент ${tool.name} уже зарегистрирован`);
    }
    this.tools.set(tool.name, tool as Tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  /** Выполнить вызов модели. Ошибки не бросаются — уходят модели текстом, чтобы она могла исправиться. */
  async call(
    name: string,
    rawArgs: string,
    ctx: ToolContext,
  ): Promise<ToolOutcome> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        ok: false,
        content: `Ошибка: неизвестный инструмент ${name}. Доступны: ${this.names().join(", ")}`,
      };
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed)
      ) {
        throw new Error("not an object");
      }
      args = parsed as Record<string, unknown>;
    } catch {
      return {
        ok: false,
        content: `Ошибка: аргументы ${name} — невалидный JSON-объект`,
      };
    }

    const missing = requiredMissing(tool.parameters, args);
    if (missing.length > 0) {
      return {
        ok: false,
        content: `Ошибка: у ${name} не хватает обязательных параметров: ${missing.join(", ")}`,
      };
    }

    if (tool.dangerous) {
      const approved = await ctx.requestApproval(
        `Разрешить ${name}(${rawArgs.slice(0, 300)})?`,
      );
      if (!approved)
        return { ok: false, content: "Владелец отклонил действие" };
    }

    try {
      return { ok: true, content: truncate(await tool.execute(args, ctx)) };
    } catch (error) {
      return {
        ok: false,
        content: `Ошибка ${name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}

function requiredMissing(
  schema: Record<string, unknown>,
  args: Record<string, unknown>,
): string[] {
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.filter(
    (key): key is string =>
      typeof key === "string" &&
      (args[key] === undefined || args[key] === null),
  );
}

export function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[обрезано ${text.length - max} символов]…\n${text.slice(-half)}`;
}
