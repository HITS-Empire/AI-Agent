import { arch, cpus, platform, release, totalmem } from "node:os";
import { asInt, asString } from "./args";
import type { Tool, ToolContext } from "./types";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface CommandRunner {
  readonly kind: "sandbox" | "host";
  readonly shellName: string;
  run(
    command: string,
    options?: { cwd?: string; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CommandResult>;
}

const DEFAULT_TIMEOUT_SEC = 30;
const MAX_TIMEOUT_SEC = 120;

export function formatCommandResult(
  shellName: string,
  result: CommandResult,
): string {
  const head = `${shellName} · ${result.timedOut ? "таймаут, " : ""}код ${result.exitCode}`;
  const parts = [head];
  if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`);
  return parts.join("\n");
}

/**
 * Команда оболочки. В режиме host реестр спрашивает владельца (`dangerous`).
 * В песочнице подтверждение не нужно: команда и так изолирована.
 */
export function shellTool(options: {
  getRunner: (ctx: ToolContext) => CommandRunner | Promise<CommandRunner>;
  host?: boolean;
}): Tool<{ command: string; timeout_sec?: number }> {
  return {
    name: "shell",
    description:
      "Выполнить команду. Linux — bash, macOS — zsh, Windows — PowerShell 7 (pwsh, не 5.1). " +
      "По умолчанию команда идёт в песочницу. На хосте владелец подтверждает каждый запуск. " +
      "Рабочий каталог — workspace. Таймаут timeout_sec, по умолчанию 30, максимум 120.",
    dangerous: options.host === true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        timeout_sec: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SEC },
      },
      required: ["command"],
    },
    async execute(args, ctx) {
      const command = asString(args.command, "command");
      const timeoutSec = asInt(
        args.timeout_sec,
        "timeout_sec",
        DEFAULT_TIMEOUT_SEC,
      );
      if (
        timeoutSec === undefined ||
        timeoutSec < 1 ||
        timeoutSec > MAX_TIMEOUT_SEC
      ) {
        throw new Error(`timeout_sec от 1 до ${MAX_TIMEOUT_SEC}`);
      }
      const runner = await options.getRunner(ctx);
      if (runner.kind === "host" && !options.host) {
        const approved = await ctx.requestApproval(
          `Выполнить на хосте (${runner.shellName}): ${command.slice(0, 200)}?`,
        );
        if (!approved)
          throw new Error("владелец не подтвердил команду на хосте");
      }
      const result = await runner.run(command, {
        cwd: ctx.workspaceRoot,
        timeoutMs: timeoutSec * 1000,
        signal: ctx.signal,
      });
      return formatCommandResult(runner.shellName, result);
    },
  };
}

/** Платформа, архитектура и оболочка. Без секретов и без домашнего каталога. */
export function osInfoTool(shellName: string): Tool {
  return {
    name: "os_info",
    description:
      "Краткие сведения об ОС, на которой работает агент: платформа, версия, архитектура, оболочка, число CPU и память.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute() {
      return JSON.stringify({
        platform: platform(),
        release: release(),
        arch: arch(),
        shell: shellName,
        cpus: cpus().length,
        memoryMb: Math.round(totalmem() / (1024 * 1024)),
      });
    },
  };
}

export function listProcessesTool(options: {
  getRunner: (ctx: ToolContext) => CommandRunner | Promise<CommandRunner>;
}): Tool {
  return {
    name: "list_processes",
    description:
      "Короткий список процессов в той же среде, где выполняется shell (песочница или хост). Не больше 40 строк.",
    parameters: { type: "object", properties: {}, required: [] },
    async execute(_args, ctx) {
      const runner = await options.getRunner(ctx);
      const command = runner.shellName.startsWith("pwsh")
        ? "Get-Process | Select-Object -First 40 Id,ProcessName | Format-Table | Out-String -Width 120"
        : "ps -eo pid,comm | head -n 40";
      const result = await runner.run(command, {
        cwd: ctx.workspaceRoot,
        timeoutMs: 15_000,
        signal: ctx.signal,
      });
      return formatCommandResult(runner.shellName, result);
    },
  };
}

export function openUrlTool(options: {
  open: (url: string) => Promise<string>;
}): Tool<{ url: string }> {
  return {
    name: "open_url",
    description:
      "Открыть http(s)-ссылку в браузере на машине владельца. Всегда спрашивает подтверждение.",
    dangerous: true,
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
    async execute(args) {
      const url = asString(args.url, "url");
      assertHttpUrl(url);
      return options.open(url);
    },
  };
}

/** Только http(s). Иначе `open` мог бы открыть локальный файл. */
export function assertHttpUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("непонятный url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("open_url принимает только http и https");
  }
  return parsed;
}
