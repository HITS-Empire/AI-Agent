import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { JsonRpcMessage, Transport } from "./jsonrpc";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** Строки stderr сервера (логи MCP-сервера, не протокол). */
  onStderr?: (line: string) => void;
}

/**
 * MCP stdio: сервер — дочерний процесс, сообщения — JSON по одному на строку (без переносов внутри).
 * https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio
 */
export class StdioTransport implements Transport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";

  constructor(private readonly options: StdioTransportOptions) {}

  async start(
    onMessage: (message: JsonRpcMessage) => void,
    onClose: (error?: Error) => void,
  ): Promise<void> {
    const child = spawn(this.options.command, this.options.args ?? [], {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ["pipe", "pipe", "pipe"],
      // На Windows npx/uvx — это .cmd, без shell их не запустить
      shell: process.platform === "win32",
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) {
          try {
            onMessage(JSON.parse(line) as JsonRpcMessage);
          } catch {
            this.options.onStderr?.(`[не JSON в stdout] ${line.slice(0, 200)}`);
          }
        }
        newline = this.buffer.indexOf("\n");
      }
    });

    let stderrBuffer = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer += chunk;
      const lines = stderrBuffer.split("\n");
      stderrBuffer = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) this.options.onStderr?.(line);
    });

    child.on("exit", (code, signal) => {
      onClose(
        code === 0 || signal === "SIGTERM"
          ? undefined
          : new Error(`MCP-сервер завершился: code=${code} signal=${signal}`),
      );
    });

    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", (error) =>
        reject(
          new Error(
            `Не удалось запустить MCP-сервер ${this.options.command}: ${error.message}`,
          ),
        ),
      );
    });
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const child = this.child;
    if (!child || child.killed || !child.stdin.writable) {
      throw new Error("MCP stdio: процесс не запущен");
    }
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
