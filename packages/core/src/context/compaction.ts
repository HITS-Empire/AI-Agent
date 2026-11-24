import { notImplemented } from "@burmalda/shared";
import type { ChatMessage, LlmClient } from "../llm/types";

/** Грубая оценка токенов, пока нет точной цифры от шлюза (usage.prompt_tokens последнего ответа). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content ?? "").length;
    if (message.role === "assistant" && message.tool_calls) {
      chars += JSON.stringify(message.tool_calls).length;
    }
  }
  // Для смеси русского и английского ~3 символа на токен
  return Math.ceil(chars / 3);
}

export interface CompactionOptions {
  llm: LlmClient;
  /** Дешёвая модель для саммари (burmalda-fast). */
  model: string;
  contextWindow: number;
  /** Доля окна, после которой сжимаем (0.7 = 70%). */
  compactAt: number;
  /** Сколько последних сообщений оставить дословно. */
  keepRecent: number;
}

/**
 * TODO(A): если история > compactAt * contextWindow — заменить старые сообщения саммари,
 * сохранив system, последние keepRecent сообщений и целостность пар tool_call/tool.
 */
export async function compactIfNeeded(
  _messages: ChatMessage[],
  _options: CompactionOptions,
): Promise<boolean> {
  return notImplemented("compaction контекста");
}
