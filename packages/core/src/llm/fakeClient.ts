import type {
  ChatRequest,
  ChatResponse,
  ChatUsage,
  EmbeddingClient,
  LlmClient,
  ToolCall,
} from "./types";

/**
 * Сценарный LLM-клиент для тестов без токенов: отдаёт заранее заданные ответы по очереди
 * и запоминает запросы. Так тестируются цикл, инструменты, очередь и интерфейсы без подписки.
 */
export type FakeTurn =
  | { text: string; usage?: Partial<ChatUsage>; finishReason?: string }
  | {
      toolCalls: Array<{ name: string; args: unknown }>;
      text?: string;
      usage?: Partial<ChatUsage>;
    }
  | ((request: ChatRequest) => FakeTurn);

export class FakeLlmClient implements LlmClient {
  readonly requests: ChatRequest[] = [];
  private index = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  get remaining(): number {
    return this.turns.length - this.index;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    let turn = this.turns[this.index++];
    if (!turn) throw new Error("FakeLlmClient: сценарий закончился");
    if (typeof turn === "function") turn = turn(request);
    if (typeof turn === "function")
      throw new Error("FakeLlmClient: вложенная функция");

    const toolCalls: ToolCall[] | undefined =
      "toolCalls" in turn
        ? turn.toolCalls.map((call, i) => ({
            id: `call_${this.index}_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }))
        : undefined;

    const prompt = turn.usage?.prompt_tokens ?? 10;
    const completion = turn.usage?.completion_tokens ?? 5;
    return {
      id: `fake-${this.index}`,
      model: request.model,
      choices: [
        {
          index: 0,
          finish_reason: toolCalls
            ? "tool_calls"
            : ("finishReason" in turn && turn.finishReason) || "stop",
          message: {
            role: "assistant",
            content: turn.text ?? null,
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
        },
      ],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
      },
      meta: { latencyMs: 1, attempts: 1, costUsd: 0 },
    };
  }
}

/**
 * Детерминированные «эмбеддинги» для тестов: мешок слов, захешированный в вектор фиксированной длины.
 * Похожие по словам тексты получают близкие векторы — достаточно, чтобы проверить поиск.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly calls: string[][] = [];

  constructor(readonly dimensions = 1024) {}

  async embed(input: string[]): Promise<number[][]> {
    this.calls.push([...input]);
    return input.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0);
      for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (!word) continue;
        let hash = 2166136261;
        for (const char of word)
          hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
        vector[Math.abs(hash) % this.dimensions]! += 1;
      }
      const norm = Math.hypot(...vector) || 1;
      return vector.map((value) => value / norm);
    });
  }
}
