import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isEnoent } from "./fsErrors";

export interface SandboxMount {
  /** Путь на хосте. Для маски секрета это /dev/null или пустой каталог, не сам секрет. */
  hostPath: string;
  containerPath: string;
}

export interface SandboxCreateOptions {
  image: string;
  name: string;
  workspaceDir: string;
  uid: number;
  gid: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
  masks?: SandboxMount[];
}

/**
 * Аргументы `docker run` для сессии. Сеть выключена, корень только для чтения,
 * capabilities сняты, лимиты PID/RAM/CPU, в окружение не передаются секреты хоста.
 * Единственный рабочий том — workspace. Секреты внутри него закрываются отдельными монтированиями.
 */
export function sandboxCreateArgs(options: SandboxCreateOptions): string[] {
  const args = [
    "run",
    "-d",
    "--name",
    options.name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--pids-limit",
    String(options.pidsLimit ?? 256),
    "--memory",
    options.memory ?? "1g",
    "--cpus",
    options.cpus ?? "1",
    "--tmpfs",
    "/tmp:rw,nosuid,mode=1777,size=64m",
    "--user",
    `${options.uid}:${options.gid}`,
    "-e",
    "HOME=/tmp",
    "-e",
    "LANG=C.UTF-8",
    "-e",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "-v",
    `${options.workspaceDir}:/workspace:rw`,
    "-w",
    "/workspace",
    "--label",
    "burmalda.sandbox=1",
  ];
  for (const mask of options.masks ?? []) {
    args.push("-v", `${mask.hostPath}:${mask.containerPath}:ro`);
  }
  args.push(options.image, "sleep", "infinity");
  return args;
}

export function sandboxExecArgs(
  name: string,
  uid: number,
  gid: number,
  command: string,
  timeoutSec: number,
): string[] {
  return [
    "exec",
    "-u",
    `${uid}:${gid}`,
    "-w",
    "/workspace",
    name,
    "timeout",
    "-k",
    "2s",
    `${timeoutSec}s`,
    "bash",
    "-lc",
    command,
  ];
}

/** Имя контейнера стабильно для сессии и годится для docker. */
export function sandboxContainerName(sessionId: string): string {
  const hash = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 12);
  const safe = sessionId.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 24);
  return `burmalda-sb-${safe || "session"}-${hash}`;
}

/**
 * Если в workspace уже лежат секреты, закрыть их в контейнере пустым монтированием.
 * Сам файл секрета в аргументы docker не попадает: вместо него /dev/null или пустой каталог.
 */
export async function secretMasks(
  workspaceDir: string,
): Promise<SandboxMount[]> {
  const root = resolve(workspaceDir);
  const masks: SandboxMount[] = [];
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if (isEnoent(error)) return masks;
    throw error;
  }
  for (const name of names) {
    if (name === ".secrets") {
      const empty = join(
        tmpdir(),
        `burmalda-mask-${sandboxContainerName(root).slice(-12)}`,
      );
      await mkdir(empty, { recursive: true });
      masks.push({
        hostPath: empty,
        containerPath: "/workspace/.secrets",
      });
      continue;
    }
    if (
      name === ".env" ||
      (name.startsWith(".env.") && name !== ".env.example")
    ) {
      const info = await stat(join(root, name)).catch(() => undefined);
      if (!info?.isFile()) continue;
      masks.push({
        hostPath: "/dev/null",
        containerPath: `/workspace/${name}`,
      });
    }
  }
  return masks;
}
