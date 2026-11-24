import type { JsonSchema } from "../llm/types";
import type { ToolRegistry } from "../tools/registry";
import type { Tool } from "../tools/types";
import { HttpTransport, McpSessionExpiredError } from "./httpTransport";
import { JsonRpcPeer, type Transport } from "./jsonrpc";
import { StdioTransport } from "./stdioTransport";

/**
 * MCP-клиент пишем сами: JSON-RPC 2.0 поверх stdio (spawn) и Streamable HTTP.
 * Официальный SDK не используем — подключение к MCP входит в «ядро без библиотек».
 * Спецификация: https://modelcontextprotocol.io/specification
 */
export const MCP_PROTOCOL_VERSION = "2025-06-18";
/** Версии, с которыми клиент умеет работать (Streamable HTTP появился в 2025-03-26). */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"];

export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      name: string;
      transport: "http";
      url: string;
      headers?: Record<string, string>;
    };

export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

interface McpContentItem {
  type: string;
  text?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string };
  uri?: string;
}

interface McpCallResult {
  content?: McpContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpClientOptions {
  clientName?: string;
  clientVersion?: string;
  requestTimeoutMs?: number;
  onLog?: (line: string) => void;
  /** Сервер сообщил, что список инструментов изменился. */
  onToolsChanged?: () => void;
  /** Подмена транспорта в тестах. */
  transport?: Transport;
}

export class McpClient {
  readonly name: string;
  private readonly peer: JsonRpcPeer;
  private readonly transport: Transport;
  serverInfo?: { name: string; version?: string };
  protocolVersion?: string;
  capabilities?: Record<string, unknown>;

  constructor(
    readonly config: McpServerConfig,
    private readonly options: McpClientOptions = {},
  ) {
    this.name = config.name;
    this.transport = options.transport ?? createTransport(config, options);
    this.peer = new JsonRpcPeer(this.transport, (method, params) => {
      if (method === "notifications/message") {
        options.onLog?.(`[mcp ${config.name}] ${JSON.stringify(params)}`);
      }
      if (method === "notifications/tools/list_changed") {
        options.onToolsChanged?.();
      }
    });
  }

  /** initialize → проверка версии → notifications/initialized */
  async connect(): Promise<void> {
    await this.peer.start();
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = await this.peer.request<{
      protocolVersion: string;
      serverInfo?: { name: string; version?: string };
      capabilities?: Record<string, unknown>;
    }>(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.options.clientName ?? "burmalda",
          version: this.options.clientVersion ?? "0.1.0",
        },
      },
      this.options.requestTimeoutMs,
    );
    if (!SUPPORTED_PROTOCOL_VERSIONS.includes(result.protocolVersion)) {
      // спецификация: если версия сервера не поддерживается — отключиться
      await this.peer.close().catch(() => undefined);
      throw new Error(
        `MCP ${this.name}: версия протокола сервера ${result.protocolVersion} не поддерживается (умеем ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`,
      );
    }
    this.protocolVersion = result.protocolVersion;
    this.serverInfo = result.serverInfo;
    this.capabilities = result.capabilities;
    this.transport.setProtocolVersion?.(result.protocolVersion);
    await this.peer.notify("notifications/initialized");
  }

  /** Запрос с одним повтором после нового initialize, если HTTP-сервер забыл сессию. */
  private async requestWithSession<T>(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    try {
      return await this.peer.request<T>(method, params, timeoutMs);
    } catch (error) {
      if (!(error instanceof McpSessionExpiredError)) throw error;
      await this.initialize();
      return this.peer.request<T>(method, params, timeoutMs);
    }
  }

  async listTools(): Promise<McpToolInfo[]> {
    // инструменты есть, только если сервер объявил capability tools
    if (this.capabilities && !("tools" in this.capabilities)) return [];
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.requestWithSession<{
        tools: Array<{
          name: string;
          description?: string;
          inputSchema?: JsonSchema;
        }>;
        nextCursor?: string;
      }>("tools/list", cursor ? { cursor } : {}, this.options.requestTimeoutMs);
      for (const tool of page.tools ?? []) {
        tools.push({
          server: this.name,
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.requestWithSession<McpCallResult>(
      "tools/call",
      { name, arguments: args },
      this.options.requestTimeoutMs ?? 120_000,
    );
    const text = renderContent(result);
    return result.isError ? `Ошибка MCP-инструмента: ${text}` : text;
  }

  async close(): Promise<void> {
    await this.peer.close();
  }
}

function createTransport(
  config: McpServerConfig,
  options: McpClientOptions,
): Transport {
  if (config.transport === "stdio") {
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      onStderr: (line) => options.onLog?.(`[mcp ${config.name}] ${line}`),
    });
  }
  return new HttpTransport({ url: config.url, headers: config.headers });
}

export function renderContent(result: McpCallResult): string {
  const parts: string[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && item.text !== undefined) parts.push(item.text);
    else if (item.type === "resource" && item.resource?.text)
      parts.push(item.resource.text);
    else if (item.type === "resource_link" && item.uri)
      parts.push(`[ссылка] ${item.uri}`);
    else
      parts.push(`[${item.type}${item.mimeType ? ` ${item.mimeType}` : ""}]`);
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent));
  }
  return parts.join("\n");
}

/** Имя инструмента MCP в реестре: mcp__<server>__<tool>, только [a-zA-Z0-9_-], до 64 символов. */
export function mcpToolName(server: string, tool: string): string {
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `mcp__${clean(server)}__${clean(tool)}`.slice(0, 64);
}

/** Регистрирует все инструменты сервера в реестре агента. Возвращает их имена. */
export async function registerMcpTools(
  client: McpClient,
  registry: ToolRegistry,
): Promise<string[]> {
  const names: string[] = [];
  for (const info of await client.listTools()) {
    const name = mcpToolName(info.server, info.name);
    if (registry.has(name)) continue;
    const tool: Tool = {
      name,
      description: `[MCP ${info.server}] ${info.description}`.slice(0, 1024),
      parameters: normalizeSchema(info.inputSchema),
      execute: (args) => client.callTool(info.name, args),
    };
    registry.register(tool);
    names.push(name);
  }
  return names;
}

function normalizeSchema(schema: JsonSchema): JsonSchema {
  return schema.type === "object"
    ? schema
    : { type: "object", properties: {}, ...schema };
}
