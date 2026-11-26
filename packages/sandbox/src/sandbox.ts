import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { assertCommandAllowed, DEFAULT_ALLOWLIST } from "./allowlist";
import {
  sandboxContainerName,
  sandboxCreateArgs,
  sandboxExecArgs,
  secretMasks,
} from "./dockerArgs";
import { killTree, sanitizedEnv } from "./host";
import type { ShellResult, ShellRunner } from "./types";

const liveContainers = new Set<string>();

export interface SandboxRunnerOptions {
  image: string;
  workspaceDir: string;
  sessionId: string;
  dockerBin?: string;
  allowlist?: readonly string[];
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  /** Не логировать саму команду: в ней может быть то, что не стоит писать в журнал. */
  log?: (
    level: "info" | "warn",
    data: Record<string, unknown>,
    msg: string,
  ) => void;
}

/**
 * Контейнер на сессию. Повторный вызов с тем же sessionId переиспользует его.
 * docker.sock и секреты хоста внутрь не монтируются.
 */
export function createSandboxRunner(
  options: SandboxRunnerOptions,
): ShellRunner {
  const dockerBin = options.dockerBin ?? "docker";
  const name = sandboxContainerName(options.sessionId);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  let ready: Promise<void> | undefined;

  const ensure = (): Promise<void> => {
    if (!ready) {
      ready = prepare(options, dockerBin, name, uid, gid).catch(
        (error: unknown) => {
          ready = undefined;
          throw error;
        },
      );
    }
    return ready;
  };

  return {
    kind: "sandbox",
    shellName: "bash (docker)",
    async run(command, runOptions) {
      if (!command.trim()) throw new Error("пустая команда");
      assertCommandAllowed(command, options.allowlist ?? DEFAULT_ALLOWLIST);
      await ensure();
      const timeoutMs = runOptions?.timeoutMs ?? 30_000;
      const timeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000));
      const started = Date.now();
      const result = await runDocker(
        dockerBin,
        sandboxExecArgs(name, uid, gid, command, timeoutSec),
        timeoutMs + 5_000,
        runOptions?.signal,
      );
      const timedOut = result.timedOut || result.exitCode === 124;
      options.log?.(
        timedOut || result.exitCode !== 0 ? "warn" : "info",
        {
          sandbox: name,
          exitCode: result.exitCode,
          timedOut,
          ms: Date.now() - started,
        },
        "песочница: команда",
      );
      return { ...result, timedOut };
    },
  };
}

async function prepare(
  options: SandboxRunnerOptions,
  dockerBin: string,
  name: string,
  uid: number,
  gid: number,
): Promise<void> {
  const workspaceDir = resolve(options.workspaceDir);
  await mkdir(workspaceDir, { recursive: true });
  const masks = await secretMasks(workspaceDir);
  const createArgs = sandboxCreateArgs({
    image: options.image,
    name,
    workspaceDir,
    uid,
    gid,
    memory: options.memory,
    cpus: options.cpus,
    pidsLimit: options.pidsLimit,
    masks,
  });
  await ensureContainer(dockerBin, name, createArgs);
  liveContainers.add(name);
}

async function ensureContainer(
  dockerBin: string,
  name: string,
  createArgs: string[],
): Promise<void> {
  const inspect = await runDocker(
    dockerBin,
    ["inspect", "-f", "{{.State.Running}}", name],
    15_000,
  );
  if (inspect.exitCode === 0) {
    if (inspect.stdout.trim() !== "true") {
      const started = await runDocker(dockerBin, ["start", name], 20_000);
      if (started.exitCode !== 0) {
        throw new Error(
          `не удалось запустить песочницу: ${started.stderr.trim() || started.stdout.trim()}`,
        );
      }
    }
    return;
  }
  const created = await runDocker(dockerBin, createArgs, 60_000);
  if (created.exitCode !== 0) {
    if (/already in use|is already in use/i.test(created.stderr)) {
      const started = await runDocker(dockerBin, ["start", name], 20_000);
      if (started.exitCode === 0) return;
    }
    throw new Error(
      `не удалось создать песочницу: ${created.stderr.trim() || created.stdout.trim()}`,
    );
  }
}

/** Остановить контейнеры, которые этот процесс поднял. Чужие не трогает. */
export async function stopAllSandboxes(dockerBin = "docker"): Promise<void> {
  const names = [...liveContainers];
  liveContainers.clear();
  await Promise.all(
    names.map(async (name) => {
      await runDocker(dockerBin, ["rm", "-f", name], 20_000).catch(
        () => undefined,
      );
    }),
  );
}

function runDocker(
  dockerBin: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(dockerBin, args, {
      env: sanitizedEnv(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut });
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      timedOut = true;
      killTree(child);
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort);
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < 100_000) stdout = (stdout + chunk).slice(0, 100_000);
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < 100_000) stderr = (stderr + chunk).slice(0, 100_000);
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        fail(new Error("docker не найден: песочница не может запуститься"));
        return;
      }
      fail(error);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));
  });
}
