import type { JsonRpcMessage, Transport } from "./jsonrpc";

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * MCP Streamable HTTP: каждое сообщение клиента — POST; ответ — JSON или поток SSE.
 * Сессия — заголовок Mcp-Session-Id из ответа на initialize.
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http
 */
export class HttpTransport implements Transport {
  private onMessage?: (message: JsonRpcMessage) => void;
  private sessionId?: string;
  private protocolVersion?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async start(onMessage: (message: JsonRpcMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const response = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: this.headers({
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      }),
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
    });

    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;

    if (response.status === 202 || response.status === 204) return;
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`MCP HTTP ${response.status}: ${text.slice(0, 300)}`);
    }

    const type = response.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      await this.readSse(response);
      return;
    }
    const text = await response.text();
    if (!text.trim()) return;
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      this.onMessage?.(item);
    }
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    await this.fetchImpl(this.options.url, {
      method: "DELETE",
      headers: this.headers({}),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    this.sessionId = undefined;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      ...this.options.headers,
      ...extra,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion
        ? { "mcp-protocol-version": this.protocolVersion }
        : {}),
    };
  }

  private async readSse(response: Response): Promise<void> {
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      buffer = this.drainEvents(buffer);
    }
    buffer += decoder.decode();
    this.drainEvents(`${buffer}\n\n`);
  }

  /** Разбирает готовые SSE-события (разделены пустой строкой), возвращает остаток. */
  private drainEvents(buffer: string): string {
    const normalized = buffer.replace(/\r\n/g, "\n");
    const events = normalized.split("\n\n");
    const rest = events.pop() ?? "";
    for (const event of events) {
      const data = parseSseData(event);
      if (data) {
        this.onMessage?.(JSON.parse(data) as JsonRpcMessage);
      }
    }
    return rest;
  }
}

/** Поле data события SSE (многострочное склеивается через \n). */
export function parseSseData(event: string): string | null {
  const lines = event
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return lines.length > 0 ? lines.join("\n") : null;
}
