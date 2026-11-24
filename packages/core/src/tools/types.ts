import type { JsonSchema } from "../llm/types";

export interface ToolContext {
  sessionId: string;
  taskId: string;
  /** Корень рабочей области агента (внутри песочницы — /workspace). */
  workspaceRoot: string;
  signal?: AbortSignal;
  /** Запросить подтверждение владельца (опасные действия: host-shell, запись вне workspace). */
  requestApproval(text: string): Promise<boolean>;
}

export interface Tool<Args = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** true — перед выполнением нужен явный ok владельца. */
  dangerous?: boolean;
  /** Возвращает текст для модели. Длинный вывод обрезается в реестре. */
  execute(args: Args, ctx: ToolContext): Promise<string>;
}
