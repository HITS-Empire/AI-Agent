import type { ToolSpec } from "../llm/types";
import type { Tool, ToolContext } from "./types";

/** Максимум символов результата инструмента, который уходит в контекст модели. */
export const MAX_TOOL_OUTPUT_CHARS = 20_000;

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Инструмент ${tool.name} уже зарегистрирован`);
    }
    this.tools.set(tool.name, tool);
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

  async call(name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) return `Ошибка: неизвестный инструмент ${name}`;

    let args: Record<string, unknown>;
    try {
      args = rawArgs ? (JSON.parse(rawArgs) as Record<string, unknown>) : {};
    } catch {
      return `Ошибка: аргументы ${name} — невалидный JSON`;
    }

    if (tool.dangerous) {
      const approved = await ctx.requestApproval(
        `Разрешить ${name}(${rawArgs.slice(0, 300)})?`,
      );
      if (!approved) return "Владелец отклонил действие";
    }

    try {
      return truncate(await tool.execute(args, ctx));
    } catch (error) {
      return `Ошибка ${name}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT_CHARS) return text;
  const half = MAX_TOOL_OUTPUT_CHARS / 2;
  return `${text.slice(0, half)}\n…[обрезано ${text.length - MAX_TOOL_OUTPUT_CHARS} символов]…\n${text.slice(-half)}`;
}
