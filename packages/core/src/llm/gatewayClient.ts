import type {
  ChatRequest,
  ChatResponse,
  EmbeddingClient,
  LlmClient,
} from "./types";

export interface GatewayClientOptions {
  baseUrl: string;
  /** Виртуальный ключ LiteLLM (не master key и не ключ провайдера). */
  apiKey: string;
  timeoutMs?: number;
  /** Ретраи на 429, 5xx и сетевые ошибки. */
  maxRetries?: number;
  /** Базовая пауза между ретраями, удваивается. */
  retryBaseMs?: number;
  /** Подмена fetch в тестах. */
  fetchImpl?: typeof fetch;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

/** Сведения о виртуальном ключе из LiteLLM: расход и бюджет. */
export interface KeyInfo {
  spend: number;
  maxBudget: number | null;
  budgetResetAt: string | null;
  models: string[];
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

/**
 * Клиент LLM-шлюза на голом fetch. Это единственное место в коде, которое ходит к моделям:
 * прямые вызовы провайдеров в обход шлюза запрещены заданием.
 */
export class GatewayClient implements LlmClient, EmbeddingClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GatewayClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async chat(
    request: ChatRequest,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    const { data, costUsd, latencyMs, attempts } =
      await this.post<ChatResponse>("/v1/chat/completions", request, signal);
    if (!Array.isArray(data.choices)) {
      throw new GatewayError("Шлюз вернул ответ без choices");
    }
    return { ...data, meta: { costUsd, latencyMs, attempts } };
  }

  async embed(
    input: string[],
    model: string,
    signal?: AbortSignal,
  ): Promise<number[][]> {
    if (input.length === 0) return [];
    const { data } = await this.post<{
      data: Array<{ index: number; embedding: number[] }>;
    }>("/v1/embeddings", { model, input }, signal);
    if (!Array.isArray(data.data) || data.data.length !== input.length) {
      throw new GatewayError("Шлюз вернул неожиданный ответ на embeddings");
    }
    return [...data.data]
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
  }

  /** Расход и бюджет текущего ключа (`GET /key/info`). */
  async keyInfo(signal?: AbortSignal): Promise<KeyInfo> {
    const response = await this.fetchImpl(this.url("/key/info"), {
      headers: { authorization: `Bearer ${this.options.apiKey}` },
      signal: this.signal(signal),
    });
    if (!response.ok) {
      throw new GatewayError(
        `Шлюз /key/info: HTTP ${response.status}`,
        response.status,
      );
    }
    const body = (await response.json()) as {
      info?: {
        spend?: number;
        max_budget?: number | null;
        budget_reset_at?: string | null;
        models?: string[];
      };
    };
    return {
      spend: body.info?.spend ?? 0,
      maxBudget: body.info?.max_budget ?? null,
      budgetResetAt: body.info?.budget_reset_at ?? null,
      models: body.info?.models ?? [],
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<{
    data: T;
    costUsd?: number;
    latencyMs: number;
    attempts: number;
  }> {
    const maxRetries = this.options.maxRetries ?? 3;
    const baseDelay = this.options.retryBaseMs ?? 1000;
    const started = Date.now();
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const response = await this.fetchImpl(this.url(path), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: this.signal(signal),
        });

        if (!response.ok) {
          const text = await response.text();
          throw new GatewayError(
            `Шлюз вернул ${response.status}: ${text.slice(0, 500)}`,
            response.status,
            RETRYABLE_STATUSES.has(response.status),
          );
        }

        const cost = Number(response.headers.get("x-litellm-response-cost"));
        return {
          data: (await response.json()) as T,
          costUsd: Number.isFinite(cost) ? cost : undefined,
          latencyMs: Date.now() - started,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error;
        if (signal?.aborted || !isRetryable(error) || attempt > maxRetries) {
          throw error;
        }
        await sleep(baseDelay * 2 ** (attempt - 1), signal);
      }
    }
    throw lastError;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}${path}`;
  }

  private signal(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 300_000);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

function isRetryable(error: unknown): boolean {
  if (error instanceof GatewayError) return error.retryable;
  // Сетевые ошибки fetch (ECONNREFUSED, сброс соединения) — TypeError
  return error instanceof TypeError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}
