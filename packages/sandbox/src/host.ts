import { spawn, type ChildProcess } from "node:child_process";
import {
  detectHostShell,
  type HostShell,
  type ShellResult,
  type ShellRunner,
} from "./types";

const OUTPUT_LIMIT = 100_000;
const DEFAULT_TIMEOUT_MS = 30_000;

const DROP_ENV = new Set([
  "DATABASE_URL",
  "REDIS_URL",
  "POSTGRES_PASSWORD",
  "POSTGRES_USER",
]);

/** Имена вроде *_KEY, *_TOKEN, *PASSWORD* не попадают в окружение команды. */
const SECRET_ENV =
  /(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)($|_)/i;

export interface HostRunnerOptions {
  /** Бинарник вместо pwsh/bash/zsh — для тестов. */
  bin?: string;
  defaultTimeoutMs?: number;
}

/**
 * Окружение процесса без секретов. PATH и системные переменные остаются,
 * ключи, токены, пароли и URL баз — нет.
 */
export function sanitizedEnv(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (DROP_ENV.has(name) || SECRET_ENV.test(name)) continue;
    env[name] = value;
  }
  env.PYTHONIOENCODING ??= "utf-8";
  env.PYTHONUTF8 ??= "1";
  return env;
}

/** Старшая цифра версии из вывода `pwsh`. `PowerShell 7.4.6` → 7, `5.1.19041` → 5. */
export function parsePwshMajor(output: string): number | null {
  const match = /(\d+)\.\d+/.exec(output);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * Команда не должна читать секреты даже на хосте: `.env` (кроме примера), `.secrets`, ключи.
 */
export function commandTouchesSecrets(command: string): boolean {
  if (command.includes(".secrets")) return true;
  if (/auth\.json|id_rsa|id_dsa|id_ecdsa|id_ed25519|\.pem\b/.test(command)) {
    return true;
  }
  for (const match of command.matchAll(
    /(?:^|[^A-Za-z0-9_])(\.env(?:\.[A-Za-z0-9_-]+)?)/g,
  )) {
    if (match[1] !== ".env.example") return true;
  }
  return false;
}

/** Какой бинарник и аргументы запускают команду. pwsh — именно 7+, с UTF-8. */
export function hostInvocation(
  shell: HostShell,
  command: string,
  bin?: string,
): { cmd: string; args: string[] } {
  if (shell === "pwsh") {
    const wrapped = [
      "$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
      command,
    ].join("\n");
    return {
      cmd: bin ?? "pwsh",
      args: ["-NoProfile", "-NonInteractive", "-Command", wrapped],
    };
  }
  return {
    cmd: bin ?? shell,
    args: ["-lc", command],
  };
}

/**
 * Host-режим. Только после подтверждения владельца: секреты из окружения вырезаны,
 * pwsh младше 7 не запускается, по таймауту убивается дерево процессов.
 */
export function createHostRunner(
  shell: HostShell = detectHostShell(),
  options: HostRunnerOptions = {},
): ShellRunner {
  let shellName = shell === "pwsh" ? "pwsh" : shell === "zsh" ? "zsh" : "bash";
  let versionChecked = shell !== "pwsh";

  return {
    kind: "host",
    get shellName() {
      return shellName;
    },
    async run(command, runOptions) {
      if (!command.trim()) throw new Error("пустая команда");
      if (commandTouchesSecrets(command)) {
        throw new Error(
          "команда обращается к секретам (.env, .secrets, ключи) — отказ",
        );
      }
      if (!versionChecked) {
        const version = await readPwshVersion(options.bin ?? "pwsh");
        shellName = `pwsh ${version}`;
        versionChecked = true;
      }
      const invocation = hostInvocation(shell, command, options.bin);
      return spawnCaptured(invocation.cmd, invocation.args, {
        cwd: runOptions?.cwd,
        timeoutMs:
          runOptions?.timeoutMs ??
          options.defaultTimeoutMs ??
          DEFAULT_TIMEOUT_MS,
        signal: runOptions?.signal,
        env: sanitizedEnv(),
      });
    },
  };
}

async function readPwshVersion(bin: string): Promise<string> {
  const result = await spawnCaptured(
    bin,
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$PSVersionTable.PSVersion.ToString()",
    ],
    { timeoutMs: 15_000, env: sanitizedEnv() },
  );
  if (result.timedOut) throw new Error("pwsh не ответил на запрос версии");
  if (result.exitCode !== 0) {
    throw new Error(
      `pwsh не запустился (${result.exitCode}): ${result.stderr || result.stdout || "нет вывода"}`,
    );
  }
  const major = parsePwshMajor(result.stdout);
  if (major === null) {
    throw new Error(`непонятная версия pwsh: ${result.stdout.trim()}`);
  }
  if (major < 7) {
    throw new Error(
      `нужен PowerShell 7 или новее (pwsh), найдено: ${result.stdout.trim()}. Windows PowerShell 5.1 не подходит`,
    );
  }
  return result.stdout.trim();
}

interface SpawnOptions {
  cwd?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  env: NodeJS.ProcessEnv;
}

function spawnCaptured(
  cmd: string,
  args: string[],
  options: SpawnOptions,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve({
        exitCode,
        stdout,
        stderr,
        timedOut,
      });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };

    const onAbort = () => {
      timedOut = true;
      killTree(child);
    };
    if (options.signal) {
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener("abort", onAbort);
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendCapped(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendCapped(stderr, chunk);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(
          new Error(
            `оболочка «${cmd}» не найдена. На Windows нужен PowerShell 7+ (команда pwsh), не Windows PowerShell 5.1`,
          ),
        );
        return;
      }
      fail(error);
    });
    child.on("close", (code) => {
      finish(code ?? (timedOut ? 124 : 1));
    });
  });
}

function appendCapped(current: string, chunk: string): string {
  if (current.length >= OUTPUT_LIMIT) return current;
  return (current + chunk).slice(0, OUTPUT_LIMIT);
}

/** Убить процесс и его детей: группа на Unix, taskkill /T на Windows. */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // процесс уже завершился
    }
  }
}
