import { previewValue, type Span, type Tracer } from "../observability/tracer";
import type { LlmClient } from "./types";

/**
 * Обёртка над LlmClient: каждый вызов — спан llm.chat (OpenInference LLM) с токенами и стоимостью.
 * Для служебных вызовов вне цикла агента: сводка при compaction, извлечение фактов.
 */
export function tracedClient(
  llm: LlmClient,
  tracer: Tracer,
  parent?: Span,
): LlmClient {
  return {
    async chat(request, signal) {
      const tags = request.metadata?.tags;
      const span = tracer.startSpan(
        "llm.chat",
        "LLM",
        {
          "llm.model_name": request.model,
          "burmalda.purpose": Array.isArray(tags)
            ? String(tags.at(-1))
            : undefined,
          "input.value": previewValue(request.messages.at(-1)),
        },
        parent,
      );
      try {
        const response = await llm.chat(request, signal);
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
    },
  };
}
