import type { TokenUsage } from "@burmalda/shared";
import type { ChatMessage, ChatResponse, LlmClient } from "../llm/types";
import { UsageMeter } from "../llm/usage";
import {
  noopTracer,
  previewValue,
  type Span,
  type Tracer,
} from "../observability/tracer";
import type { ToolRegistry } from "../tools/registry";
import type { ToolContext } from "../tools/types";

export interface StepInfo {
  step: number;
  /** usage.prompt_tokens последнего ответа шлюза — точный размер контекста на прошлом шаге. */
  lastPromptTokens?: number;
  /** Сколько сообщений было в истории на момент прошлого запроса. */
  messagesAtLastRequest?: number;
}

export interface AgentRunOptions {
  llm: LlmClient;
  model: string;
  tools: ToolRegistry;
  /** История: system (AGENTS.md, скиллы, память) + диалог. Мутируется — сюда дописываются шаги. */
  messages: ChatMessage[];
  ctx: ToolContext;
  maxSteps?: number;
  /** Вызывается перед каждым запросом к модели: здесь подключается compaction. */
  beforeStep?: (messages: ChatMessage[], info: StepInfo) => Promise<void>;
  /** Каждое новое сообщение (assistant, tool) — для сохранения в память сразу, а не в конце. */
  onMessage?: (message: ChatMessage) => Promise<void> | void;
  onEvent?: (event: AgentLoopEvent) => void;
  tracer?: Tracer;
  /** Родительский спан (например, задача в worker). */
  parentSpan?: Span;
  usage?: UsageMeter;
}

export type AgentLoopEvent =
  | { type: "assistant_text"; text: string }
  | { type: "tool_call"; name: string; args: string }
  | {
      type: "tool_result";
      name: string;
      result: string;
      ok: boolean;
      ms: number;
    }
  | {
      type: "llm_usage";
      model: string;
      promptTokens: number;
      completionTokens: number;
      costUsd?: number;
      latencyMs?: number;
    };

export interface AgentRunResult {
  finalText: string;
  steps: number;
  usage: TokenUsage & { costUsd: number };
  stoppedBy: "answer" | "max_steps" | "length";
}

/**
 * Базовый цикл агента с нативным tool calling:
 * модель → (tool_calls → выполнение → результаты в историю)* → финальный ответ.
 */
export async function runAgent(
  options: AgentRunOptions,
): Promise<AgentRunResult> {
  const { llm, model, tools, messages, ctx, onEvent } = options;
  const tracer = options.tracer ?? noopTracer;
  const maxSteps = options.maxSteps ?? 30;
  const meter = new UsageMeter();
  const info: StepInfo = { step: 0 };

  const agentSpan = tracer.startSpan(
    "agent.run",
    "AGENT",
    {
      "session.id": ctx.sessionId,
      "burmalda.task_id": ctx.taskId,
      "llm.model_name": model,
      "input.value": previewValue(lastUserText(messages)),
    },
    options.parentSpan,
  );

  const push = async (message: ChatMessage) => {
    messages.push(message);
    await options.onMessage?.(message);
  };

  const finish = (
    finalText: string,
    steps: number,
    stoppedBy: AgentRunResult["stoppedBy"],
  ): AgentRunResult => {
    const total = meter.total();
    agentSpan.setAttributes({
      "output.value": previewValue(finalText),
      "llm.token_count.prompt": total.promptTokens,
      "llm.token_count.completion": total.completionTokens,
      "llm.token_count.total": total.totalTokens,
      "burmalda.steps": steps,
      "burmalda.stopped_by": stoppedBy,
    });
    agentSpan.end();
    return {
      finalText,
      steps,
      stoppedBy,
      usage: {
        promptTokens: total.promptTokens,
        completionTokens: total.completionTokens,
        totalTokens: total.totalTokens,
        costUsd: total.costUsd,
      },
    };
  };

  try {
    for (let step = 1; step <= maxSteps; step++) {
      info.step = step;
      await options.beforeStep?.(messages, info);

      const response = await callModel(
        llm,
        model,
        messages,
        tools,
        ctx,
        tracer,
        agentSpan,
      );
      info.lastPromptTokens = response.usage?.prompt_tokens;
      info.messagesAtLastRequest = messages.length;

      meter.record(model, response);
      options.usage?.record(model, response);
      onEvent?.({
        type: "llm_usage",
        model,
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        costUsd: response.meta?.costUsd,
        latencyMs: response.meta?.latencyMs,
      });

      const choice = response.choices[0];
      if (!choice) throw new Error("Шлюз вернул ответ без choices");

      const content = choice.message.content;
      const toolCalls = choice.message.tool_calls?.length
        ? choice.message.tool_calls
        : undefined;
      await push(
        toolCalls
          ? { role: "assistant", content, tool_calls: toolCalls }
          : { role: "assistant", content },
      );
      if (content) onEvent?.({ type: "assistant_text", text: content });

      if (!toolCalls) {
        const stoppedBy =
          choice.finish_reason === "length" ? "length" : "answer";
        return finish(content ?? "", step, stoppedBy);
      }

      for (const call of toolCalls) {
        onEvent?.({
          type: "tool_call",
          name: call.function.name,
          args: call.function.arguments,
        });
        const toolSpan = tracer.startSpan(
          `tool.${call.function.name}`,
          "TOOL",
          {
            "tool.name": call.function.name,
            "input.value": previewValue(call.function.arguments),
          },
          agentSpan,
        );
        const started = Date.now();
        const outcome = await tools.call(
          call.function.name,
          call.function.arguments,
          ctx,
        );
        toolSpan.setAttributes({
          "output.value": previewValue(outcome.content),
          "burmalda.tool_ok": outcome.ok,
        });
        toolSpan.end();
        onEvent?.({
          type: "tool_result",
          name: call.function.name,
          result: outcome.content,
          ok: outcome.ok,
          ms: Date.now() - started,
        });
        await push({
          role: "tool",
          tool_call_id: call.id,
          content: outcome.content,
        });
      }
    }

    return finish(
      "Остановился: достигнут лимит шагов. Напиши «продолжай», чтобы продолжить.",
      maxSteps,
      "max_steps",
    );
  } catch (error) {
    agentSpan.recordError(error);
    agentSpan.end();
    throw error;
  }
}

async function callModel(
  llm: LlmClient,
  model: string,
  messages: ChatMessage[],
  tools: ToolRegistry,
  ctx: ToolContext,
  tracer: Tracer,
  parent: Span,
): Promise<ChatResponse> {
  const specs = tools.specs();
  const span = tracer.startSpan(
    "llm.chat",
    "LLM",
    {
      "llm.model_name": model,
      "llm.invocation_parameters": JSON.stringify({ tools: specs.length }),
      "input.value": previewValue(messages.at(-1)),
    },
    parent,
  );
  try {
    const response = await llm.chat(
      {
        model,
        messages,
        ...(specs.length > 0
          ? { tools: specs, tool_choice: "auto" as const }
          : {}),
        user: ctx.sessionId,
        metadata: { tags: ["burmalda"], task_id: ctx.taskId },
      },
      ctx.signal,
    );
    span.setAttributes({
      "llm.token_count.prompt": response.usage?.prompt_tokens,
      "llm.token_count.completion": response.usage?.completion_tokens,
      "llm.token_count.total": response.usage?.total_tokens,
      "burmalda.cost_usd": response.meta?.costUsd,
      "output.value": previewValue(response.choices[0]?.message),
    });
    return response;
  } catch (error) {
    span.recordError(error);
    throw error;
  } finally {
    span.end();
  }
}

function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role === "user") return message.content;
  }
  return "";
}
