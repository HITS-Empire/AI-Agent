import type { ChatRequest, ChatResponse, LlmClient, ToolCall } from "./types";

/**
 * Сценарный LLM-клиент для тестов без токенов: отдаёт заранее заданные ответы по очереди
 * и запоминает запросы. Так тестируются цикл, инструменты, очередь и интерфейсы без подписки.
 */
export type FakeTurn =
  { text: string } | { toolCalls: Array<{ name: string; args: unknown }> };

export class FakeLlmClient implements LlmClient {
  readonly requests: ChatRequest[] = [];
  private index = 0;

  constructor(private readonly turns: FakeTurn[]) {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone(request));
    const turn = this.turns[this.index++];
    if (!turn) throw new Error("FakeLlmClient: сценарий закончился");

    const toolCalls: ToolCall[] | undefined =
      "toolCalls" in turn
        ? turn.toolCalls.map((call, i) => ({
            id: `call_${this.index}_${i}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }))
        : undefined;

    return {
      id: `fake-${this.index}`,
      model: request.model,
      choices: [
        {
          index: 0,
          finish_reason: toolCalls ? "tool_calls" : "stop",
          message: {
            role: "assistant",
            content: "text" in turn ? turn.text : null,
            tool_calls: toolCalls,
          },
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
}
