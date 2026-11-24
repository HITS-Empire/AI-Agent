import type { TokenUsage } from "@burmalda/shared";
import type { ChatMessage, LlmClient } from "../llm/types";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";

export interface AgentRunOptions {
  llm: LlmClient;
  model: string;
  tools: ToolRegistry;
  /** История: system (AGENTS.md, скиллы, память) + диалог. Мутируется — сюда дописываются шаги. */
  messages: ChatMessage[];
  ctx: ToolContext;
  maxSteps?: number;
  /** Вызывается перед каждым шагом: тут подключается compaction. */
  beforeStep?: (messages: ChatMessage[]) => Promise<void>;
  onEvent?: (event: AgentLoopEvent) => void;
}

export type AgentLoopEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "tool_result"; name: string; result: string };

export interface AgentRunResult {
  finalText: string;
  steps: number;
  usage: TokenUsage;
  stoppedBy: "answer" | "max_steps";
}

/**
 * Базовый цикл агента с нативным tool calling:
 * модель → (tool_calls → выполнение → результаты в историю)* → финальный ответ.
 */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const { llm, model, tools, messages, ctx, onEvent } = options;
  const maxSteps = options.maxSteps ?? 30;
  const usage: TokenUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  for (let step = 1; step <= maxSteps; step++) {
    await options.beforeStep?.(messages);

    const response = await llm.chat(
      {
        model,
        messages,
        tools: tools.specs(),
        tool_choice: "auto",
        user: ctx.sessionId,
      },
      ctx.signal,
    );

    if (response.usage) {
      usage.promptTokens += response.usage.prompt_tokens;
      usage.completionTokens += response.usage.completion_tokens;
      usage.totalTokens += response.usage.total_tokens;
    }

    const choice = response.choices[0];
    if (!choice) throw new Error("Шлюз вернул ответ без choices");

    const { content, tool_calls: toolCalls } = choice.message;
    messages.push({ role: "assistant", content, tool_calls: toolCalls });
    if (content) onEvent?.({ type: "assistant_text", text: content });

    if (!toolCalls || toolCalls.length === 0) {
      return {
        finalText: content ?? "",
        steps: step,
        usage,
        stoppedBy: "answer",
      };
    }

    for (const call of toolCalls) {
      onEvent?.({
        type: "tool_call",
        name: call.function.name,
        args: call.function.arguments,
      });
      const result = await tools.call(
        call.function.name,
        call.function.arguments,
        ctx,
      );
      onEvent?.({ type: "tool_result", name: call.function.name, result });
      messages.push({ role: "tool", tool_call_id: call.id, content: result });
    }
  }

  return {
    finalText:
      "Остановился: достигнут лимит шагов. Напиши «продолжай», чтобы продолжить.",
    steps: maxSteps,
    usage,
    stoppedBy: "max_steps",
  };
}
