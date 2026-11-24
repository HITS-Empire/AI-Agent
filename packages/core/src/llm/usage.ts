import type { ChatResponse } from "./types";

export interface ModelUsage {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  costUsd: number;
}

/**
 * Учёт токенов и стоимости на стороне приложения (по сессии/задаче).
 * Источник правды по расходу — шлюз; это локальная копия для событий, логов и /usage.
 */
export class UsageMeter {
  private readonly byModel = new Map<string, ModelUsage>();

  record(model: string, response: Pick<ChatResponse, "usage" | "meta">): void {
    const current = this.byModel.get(model) ?? {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    current.calls += 1;
    current.promptTokens += response.usage?.prompt_tokens ?? 0;
    current.completionTokens += response.usage?.completion_tokens ?? 0;
    current.cachedTokens +=
      response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    current.costUsd += response.meta?.costUsd ?? 0;
    this.byModel.set(model, current);
  }

  total(): ModelUsage & { totalTokens: number } {
    const total = {
      calls: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
    };
    for (const usage of this.byModel.values()) {
      total.calls += usage.calls;
      total.promptTokens += usage.promptTokens;
      total.completionTokens += usage.completionTokens;
      total.cachedTokens += usage.cachedTokens;
      total.costUsd += usage.costUsd;
    }
    return {
      ...total,
      totalTokens: total.promptTokens + total.completionTokens,
    };
  }

  models(): Array<[string, ModelUsage]> {
    return [...this.byModel.entries()];
  }
}
