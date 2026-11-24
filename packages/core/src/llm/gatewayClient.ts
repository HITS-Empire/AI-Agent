import type { ChatRequest, ChatResponse, LlmClient } from "./types";

export interface GatewayClientOptions {
  baseUrl: string;
  /** Виртуальный ключ LiteLLM (не master key и не ключ провайдера). */
  apiKey: string;
  timeoutMs?: number;
}

/**
 * Клиент LLM-шлюза на голом fetch. Это единственное место в коде, которое ходит к моделям:
 * прямые вызовы провайдеров в обход шлюза запрещены заданием.
 */
export class GatewayClient implements LlmClient {
  constructor(private readonly options: GatewayClientOptions) {}

  async chat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 300_000);
    const response = await fetch(
      `${this.options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify(request),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Шлюз вернул ${response.status}: ${body.slice(0, 500)}`);
    }

    return (await response.json()) as ChatResponse;
  }
}
