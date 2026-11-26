import { realpath } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

/** Имена, которые агенту нельзя ни читать, ни писать: секреты не должны попасть в контекст модели. */
const SECRET_BASENAME =
  /^(id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials\.json|auth\.json)$/i;

export function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** true, если target не лежит внутри root. Оба пути уже абсолютные. */
export function isOutside(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === "") return false;
  return rel.startsWith("..") || isAbsolute(rel);
}

/**
 * Секреты закрыты всегда, даже если путь внутри workspace:
 * `.env` (но не `.env.example`), каталог `.secrets`, ключи и файлы учётных данных.
 */
export function isSecretPath(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter((part) => part && part !== ".");
  if (parts.includes(".secrets")) return true;
  const base = parts.at(-1) ?? "";
  if (base === ".env") return true;
  if (base.startsWith(".env.") && base !== ".env.example") return true;
  if (SECRET_BASENAME.test(base)) return true;
  if (base.endsWith(".pem") || base.endsWith(".p12")) return true;
  return false;
}

export interface ResolvedPath {
  /** Абсолютный путь. Для ещё не созданного файла — лексический, родитель проверен через realpath. */
  absolute: string;
  /** Путь относительно workspace через `/`, либо абсолютный, если outside. */
  relativePosix: string;
  outside: boolean;
}

/**
 * Путь относительно корня workspace с раскрытием `..` и симлинков.
 * Симлинк, ведущий наружу, считается outside: realpath родителя или самого файла
 * сравнивается с реальным корнем.
 */
export async function resolveWorkspacePath(
  workspaceRoot: string,
  userPath: string,
): Promise<ResolvedPath> {
  if (typeof userPath !== "string" || userPath.includes("\0")) {
    throw new Error("некорректный путь");
  }
  const root = await realpath(resolve(workspaceRoot));
  const joined = isAbsolute(userPath)
    ? normalize(userPath)
    : normalize(join(root, userPath));

  const suffix: string[] = [];
  let probe = joined;
  for (;;) {
    try {
      const real = await realpath(probe);
      const absolute = suffix.length === 0 ? real : join(real, ...suffix);
      const outside = isOutside(root, absolute);
      const rel = relative(root, absolute);
      return {
        absolute,
        relativePosix: outside ? toPosix(absolute) : toPosix(rel),
        outside,
      };
    } catch (error) {
      if (!isEnoent(error)) throw error;
      const parent = dirname(probe);
      if (parent === probe) {
        const outside = isOutside(root, joined);
        const rel = relative(root, joined);
        return {
          absolute: joined,
          relativePosix: outside ? toPosix(joined) : toPosix(rel),
          outside,
        };
      }
      suffix.unshift(basename(probe));
      probe = parent;
    }
  }
}
