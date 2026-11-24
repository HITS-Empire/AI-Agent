/**
 * JSON-RPC 2.0 — основа протокола MCP. Пишем сами, без SDK.
 * https://www.jsonrpc.org/specification
 */
export type JsonRpcId = number | string;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId | null;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage =
  JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export class JsonRpcRemoteError extends Error {
  constructor(readonly error: JsonRpcError) {
    super(`JSON-RPC ${error.code}: ${error.message}`);
    this.name = "JsonRpcRemoteError";
  }
}

export function isResponse(
  message: JsonRpcMessage,
): message is JsonRpcResponse {
  return "id" in message && !("method" in message);
}

export function isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
  return "id" in message && "method" in message;
}

/** Транспорт MCP: доставляет сообщения JSON-RPC в обе стороны. */
export interface Transport {
  start(
    onMessage: (message: JsonRpcMessage) => void,
    onClose: (error?: Error) => void,
  ): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  /** Версия протокола после initialize (HTTP-транспорт шлёт её заголовком). */
  setProtocolVersion?(version: string): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Сторона JSON-RPC поверх транспорта: запросы с таймаутами, уведомления,
 * ответы на запросы сервера (ping — {}, остальное — «метод не найден»).
 */
export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, Pending>();
  private closed = false;

  constructor(
    private readonly transport: Transport,
    private readonly onNotification?: (method: string, params: unknown) => void,
  ) {}

  async start(): Promise<void> {
    await this.transport.start(
      (message) => this.handle(message),
      (error) => this.failAll(error ?? new Error("MCP: соединение закрыто")),
    );
  }

  request<T>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (this.closed)
      return Promise.reject(new Error("MCP: соединение закрыто"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // MCP: о брошенном запросе сообщаем серверу, чтобы он прекратил работу
        void this.notify("notifications/cancelled", {
          requestId: id,
          reason: "timeout",
        }).catch(() => undefined);
        reject(new Error(`MCP: таймаут ${method} (${timeoutMs} мс)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.transport
        .send({
          jsonrpc: "2.0",
          id,
          method,
          ...(params === undefined ? {} : { params }),
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error instanceof Error ? error : new Error(String(error)));
        });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error("MCP: соединение закрыто клиентом"));
    await this.transport.close();
  }

  private handle(message: JsonRpcMessage): void {
    if (isResponse(message)) {
      if (message.id === null) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new JsonRpcRemoteError(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (isRequest(message)) {
      const reply: JsonRpcResponse =
        message.method === "ping"
          ? { jsonrpc: "2.0", id: message.id, result: {} }
          : {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32601,
                message: `Метод не поддерживается клиентом: ${message.method}`,
              },
            };
      void this.transport.send(reply).catch(() => undefined);
      return;
    }
    this.onNotification?.(message.method, message.params);
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
