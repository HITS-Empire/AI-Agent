/**
 * Общие контракты между ядром, harness и интерфейсами.
 * Меняем только по договорённости обоих участников (см. AGENTS.md).
 */

/** Канал, из которого пришло сообщение. Память и очередь общие для всех каналов. */
export type Channel = "cli" | "telegram" | "web" | "scheduler";

/** Задача для агента в общей очереди. */
export interface AgentTask {
  taskId: string;
  /** Сессия владельца: одна и та же в Telegram и CLI, поэтому разговор можно продолжить в другом канале. */
  sessionId: string;
  channel: Channel;
  text: string;
  createdAt: string;
}

/** События, которые worker публикует обратно в интерфейсы (Redis pub/sub по sessionId). */
export type AgentEvent =
  | { type: "status"; taskId: string; text: string }
  | { type: "tool_call"; taskId: string; name: string; argsPreview: string }
  | { type: "tool_result"; taskId: string; name: string; ok: boolean }
  | {
      type: "approval_required";
      taskId: string;
      requestId: string;
      text: string;
    }
  | { type: "message"; taskId: string; text: string }
  | { type: "done"; taskId: string; usage?: TokenUsage }
  | { type: "error"; taskId: string; text: string };

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}
