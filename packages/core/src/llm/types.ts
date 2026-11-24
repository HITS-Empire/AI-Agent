/**
 * Формат сообщений OpenAI Chat Completions — его понимает LiteLLM для любого провайдера.
 * Типы свои, без SDK: ядро по заданию пишется без библиотек.
 */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** JSON Schema параметров инструмента. */
export type JsonSchema = Record<string, unknown>;

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  tool_choice?: "auto" | "none" | "required";
  temperature?: number;
  /** Атрибуция в шлюзе: попадает в spend logs LiteLLM. */
  user?: string;
}

export interface ChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    finish_reason: "stop" | "tool_calls" | "length" | string;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: ToolCall[];
    };
  }>;
  usage?: ChatUsage;
}

export interface LlmClient {
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}
