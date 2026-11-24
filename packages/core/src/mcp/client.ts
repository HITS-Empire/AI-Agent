import { notImplemented } from "@burmalda/shared";
import type { JsonSchema } from "../llm/types";

/**
 * MCP-клиент пишем сами: JSON-RPC 2.0 поверх stdio (spawn) и Streamable HTTP.
 * Официальный SDK не используем — подключение к MCP входит в «ядро без библиотек».
 * Спецификация: https://modelcontextprotocol.io/specification
 */
export type McpServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
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

export interface McpClient {
  /** initialize + notifications/initialized */
  connect(): Promise<void>;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

/** TODO(A): реализация транспортов и протокола. */
export function createMcpClient(_config: McpServerConfig): McpClient {
  return notImplemented("MCP-клиент");
}
