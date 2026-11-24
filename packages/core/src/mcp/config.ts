import { readFile } from "node:fs/promises";
import type { McpServerConfig } from "./client";

/**
 * Конфиг MCP-серверов (`config/mcp.json`), формат как у Claude/Cursor:
 * { "mcpServers": { "github": { "url": "...", "headers": {...} }, "fs": { "command": "npx", "args": [...] } } }
 * Значения вида ${VAR} подставляются из окружения; сервер с пустой обязательной переменной пропускается.
 */
interface RawServer {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

export interface LoadedMcpConfig {
  servers: McpServerConfig[];
  skipped: Array<{ name: string; reason: string }>;
}

export async function loadMcpConfig(
  path: string,
  env: Record<string, string | undefined> = process.env,
): Promise<LoadedMcpConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { servers: [], skipped: [] };
    }
    throw error;
  }
  return parseMcpConfig(raw, env);
}

export function parseMcpConfig(
  raw: string,
  env: Record<string, string | undefined>,
): LoadedMcpConfig {
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, RawServer> };
  const servers: McpServerConfig[] = [];
  const skipped: LoadedMcpConfig["skipped"] = [];

  for (const [name, server] of Object.entries(parsed.mcpServers ?? {})) {
    if (server.disabled) {
      skipped.push({ name, reason: "disabled" });
      continue;
    }
    const missing = new Set<string>();
    const sub = (value: string) =>
      value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
        const resolved = env[key];
        if (!resolved) missing.add(key);
        return resolved ?? "";
      });
    const subRecord = (record?: Record<string, string>) =>
      record
        ? Object.fromEntries(
            Object.entries(record).map(([k, v]) => [k, sub(v)]),
          )
        : undefined;

    let config: McpServerConfig;
    if (server.url) {
      config = {
        name,
        transport: "http",
        url: sub(server.url),
        headers: subRecord(server.headers),
      };
    } else if (server.command) {
      config = {
        name,
        transport: "stdio",
        command: sub(server.command),
        args: server.args?.map(sub),
        env: subRecord(server.env),
        cwd: server.cwd ? sub(server.cwd) : undefined,
      };
    } else {
      skipped.push({ name, reason: "нет ни url, ни command" });
      continue;
    }

    if (missing.size > 0) {
      skipped.push({
        name,
        reason: `не заданы переменные: ${[...missing].join(", ")}`,
      });
      continue;
    }
    servers.push(config);
  }
  return { servers, skipped };
}
