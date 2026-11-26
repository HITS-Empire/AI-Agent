import {
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { IgnoreSet, matchGlob } from "../fs/ignore";
import {
  isEnoent,
  isSecretPath,
  resolveWorkspacePath,
  toPosix,
  type ResolvedPath,
} from "../fs/paths";
import { asInt, asString } from "./args";
import type { Tool, ToolContext } from "./types";

const MAX_READ_LINES = 400;
const MAX_SEARCH_FILES = 2000;
const MAX_SEARCH_HITS = 40;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const MAX_DIR_ENTRIES = 200;

/**
 * Инструменты файлов. Всё внутри workspace. Выход (`..`, абсолютный путь, симлинк наружу)
 * выполняется только после подтверждения владельца. Секреты (`.env`, `.secrets`, ключи) закрыты всегда.
 */
export function fsTools(): Tool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    searchFilesTool,
  ];
}

const readFileTool: Tool = {
  name: "read_file",
  description:
    "Прочитать текстовый файл внутри workspace. Номера строк в ответе — для ориентира, в файл они не входят. " +
    "Диапазон start_line/end_line — включительно, с 1. Большой файл читай кусками.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь относительно workspace" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["path"],
  },
  async execute(args, ctx) {
    const path = asString(args.path, "path");
    const start = asInt(args.start_line, "start_line");
    const end = asInt(args.end_line, "end_line");
    if (start !== undefined && start < 1) {
      throw new Error("start_line начинается с 1");
    }
    if (end !== undefined && start !== undefined && end < start) {
      throw new Error("end_line меньше start_line");
    }
    const located = await locate(ctx, path, "чтение");
    let raw: string;
    try {
      raw = await readFile(located.absolute, "utf8");
    } catch (error) {
      throw fileError(error, path);
    }
    if (raw.includes("\0")) throw new Error("бинарный файл, чтение отменено");
    const lines = raw.split(/\r?\n/);
    const from = start ?? 1;
    if (from > lines.length) {
      throw new Error(`в файле ${lines.length} строк, start_line=${from}`);
    }
    const last = Math.min(end ?? lines.length, lines.length);
    const capped = Math.min(last, from + MAX_READ_LINES - 1);
    const body = lines
      .slice(from - 1, capped)
      .map((line, index) => `${from + index}|${line}`)
      .join("\n");
    const note =
      capped < last
        ? `\n…показаны строки ${from}–${capped} из ${lines.length}`
        : "";
    return `${located.relativePosix || path} (${lines.length} строк)\n${body}${note}`;
  },
};

const writeFileTool: Tool = {
  name: "write_file",
  description:
    "Создать или полностью перезаписать текстовый файл внутри workspace. Для точечной правки используй edit_file.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string", description: "Новое содержимое целиком" },
    },
    required: ["path", "content"],
  },
  async execute(args, ctx) {
    const path = asString(args.path, "path");
    const content = asString(args.content, "content", true);
    const located = await locate(ctx, path, "запись");
    await mkdir(dirname(located.absolute), { recursive: true });
    await writeFile(located.absolute, content, "utf8");
    return `записано ${located.relativePosix || path} (${Buffer.byteLength(content, "utf8")} байт)`;
  },
};

const editFileTool: Tool = {
  name: "edit_file",
  description:
    "Точечно заменить в файле фрагмент old на new. old должен встретиться ровно один раз — так правка не заденет соседний код. " +
    "Файл целиком не перезаписывай.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old: {
        type: "string",
        description: "Точный фрагмент, который нужно заменить",
      },
      new: {
        type: "string",
        description: "На что заменить. Пустая строка — удалить фрагмент",
      },
    },
    required: ["path", "old", "new"],
  },
  async execute(args, ctx) {
    const path = asString(args.path, "path");
    const oldText = asString(args.old, "old");
    const newText = asString(args.new, "new", true);
    const located = await locate(ctx, path, "запись");
    let raw: string;
    try {
      raw = await readFile(located.absolute, "utf8");
    } catch (error) {
      throw fileError(error, path);
    }
    const count = countOccurrences(raw, oldText);
    if (count === 0) throw new Error("фрагмент old не найден");
    if (count > 1) {
      throw new Error(
        `фрагмент old встречается ${count} раз — добавь соседние строки, чтобы он стал уникальным`,
      );
    }
    if (oldText === newText) return `без изменений ${path}`;
    await writeFile(located.absolute, raw.replace(oldText, newText), "utf8");
    return `обновлено ${path}`;
  },
};

const listDirTool: Tool = {
  name: "list_dir",
  description:
    "Иерархическое дерево каталога внутри workspace. Учитывает .gitignore (и вложенные), не показывает .git и секреты. " +
    "depth — сколько уровней вглубь (по умолчанию 2, максимум 8).",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Каталог относительно workspace, по умолчанию корень",
      },
      depth: { type: "integer", minimum: 1, maximum: 8 },
    },
    required: [],
  },
  async execute(args, ctx) {
    const path = args.path === undefined ? "." : asString(args.path, "path");
    const depth = asInt(args.depth, "depth", 2) ?? 2;
    if (depth < 1 || depth > 8) throw new Error("depth от 1 до 8");
    const located = await locate(ctx, path, "чтение");
    let info;
    try {
      info = await stat(located.absolute);
    } catch (error) {
      throw fileError(error, path);
    }
    if (!info.isDirectory()) throw new Error(`${path} — файл, не каталог`);
    const root = (await resolveWorkspacePath(ctx.workspaceRoot, ".")).absolute;
    const relBase = toPosix(relative(root, located.absolute));
    const ignore = new IgnoreSet();
    const lines = await renderTree(located.absolute, relBase, depth, ignore);
    const title = relBase || ".";
    return lines.length ? `${title}\n${lines.join("\n")}` : `${title}\n(пусто)`;
  },
};

const searchFilesTool: Tool = {
  name: "search_files",
  description:
    "Найти точную подстроку в текстовых файлах workspace. Учитывает .gitignore и секреты. " +
    "glob ограничивает имена, например *.ts или docs/*.md.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string" },
      path: {
        type: "string",
        description: "Где искать, по умолчанию весь workspace",
      },
      glob: { type: "string" },
    },
    required: ["query"],
  },
  async execute(args, ctx) {
    const query = asString(args.query, "query");
    const path = args.path === undefined ? "." : asString(args.path, "path");
    const glob =
      args.glob === undefined ? undefined : asString(args.glob, "glob");
    const located = await locate(ctx, path, "чтение");
    const root = (await resolveWorkspacePath(ctx.workspaceRoot, ".")).absolute;
    const ignore = new IgnoreSet();
    const hits: string[] = [];
    const state = { scanned: 0, truncated: false };
    const info = await stat(located.absolute).catch((error: unknown) => {
      throw fileError(error, path);
    });
    if (info.isDirectory()) {
      await walkSearch(
        located.absolute,
        toPosix(relative(root, located.absolute)),
        query,
        glob,
        ignore,
        hits,
        state,
      );
    } else {
      await scanFile(
        located.absolute,
        located.relativePosix,
        query,
        glob,
        hits,
        state,
      );
    }
    if (hits.length === 0) return `ничего не найдено по «${query}»`;
    return hits.join("\n") + (state.truncated ? "\n…выдача обрезана" : "");
  },
};

async function locate(
  ctx: ToolContext,
  userPath: string,
  action: "чтение" | "запись",
): Promise<ResolvedPath> {
  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, userPath);
  if (
    isSecretPath(userPath) ||
    isSecretPath(resolved.absolute) ||
    isSecretPath(resolved.relativePosix)
  ) {
    throw new Error(
      "путь закрыт: секреты (.env, .secrets, ключи) агенту недоступны",
    );
  }
  if (resolved.outside) {
    const approved = await ctx.requestApproval(
      `Путь вне workspace (${userPath}). Разрешить ${action}?`,
    );
    if (!approved) {
      throw new Error("путь вне workspace, владелец не подтвердил");
    }
  }
  return resolved;
}

function fileError(error: unknown, path: string): Error {
  const code = (error as { code?: string }).code;
  if (code === "ENOENT") return new Error(`нет такого файла: ${path}`);
  if (code === "EISDIR") return new Error(`${path} — каталог, не файл`);
  return error instanceof Error ? error : new Error(String(error));
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index === -1) return count;
    count++;
    from = index + needle.length;
  }
  return count;
}

async function loadGitignore(
  dir: string,
  relPosix: string,
  ignore: IgnoreSet,
): Promise<void> {
  try {
    ignore.addFile(await readFile(join(dir, ".gitignore"), "utf8"), relPosix);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

async function renderTree(
  dir: string,
  relPosix: string,
  depth: number,
  ignore: IgnoreSet,
): Promise<string[]> {
  await loadGitignore(dir, relPosix, ignore);
  const entries = await readdir(dir, { withFileTypes: true });
  const visible = entries
    .filter((entry) => entry.name !== ".git")
    .filter((entry) => {
      const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      if (isSecretPath(childRel)) return false;
      if (entry.isSymbolicLink()) return true;
      return !ignore.denies(childRel, entry.isDirectory());
    })
    .sort((a, b) => a.name.localeCompare(b.name, "en"));

  const shown = visible.slice(0, MAX_DIR_ENTRIES);
  const truncated = visible.length > shown.length;
  const lines: string[] = [];
  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i]!;
    const last = i === shown.length - 1 && !truncated;
    const branch = last ? "└── " : "├── ";
    const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
    const childAbs = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(childAbs);
      } catch {
        target = "?";
      }
      lines.push(`${branch}${entry.name} -> ${target}`);
      continue;
    }
    if (entry.isDirectory()) {
      lines.push(`${branch}${entry.name}/`);
      if (depth > 1) {
        const nested = await renderTree(childAbs, childRel, depth - 1, ignore);
        const pad = last ? "    " : "│   ";
        for (const line of nested) lines.push(pad + line);
      }
      continue;
    }
    lines.push(`${branch}${entry.name}`);
  }
  if (truncated) lines.push(`└── …ещё ${visible.length - shown.length}`);
  return lines;
}

interface SearchState {
  scanned: number;
  truncated: boolean;
}

async function walkSearch(
  dir: string,
  relPosix: string,
  query: string,
  glob: string | undefined,
  ignore: IgnoreSet,
  hits: string[],
  state: SearchState,
): Promise<void> {
  if (state.truncated) return;
  await loadGitignore(dir, relPosix, ignore);
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (hits.length >= MAX_SEARCH_HITS || state.scanned >= MAX_SEARCH_FILES) {
      state.truncated = true;
      return;
    }
    if (entry.name === ".git" || entry.isSymbolicLink()) continue;
    const childRel = relPosix ? `${relPosix}/${entry.name}` : entry.name;
    if (isSecretPath(childRel)) continue;
    const isDir = entry.isDirectory();
    if (ignore.denies(childRel, isDir)) continue;
    const childAbs = join(dir, entry.name);
    if (isDir) {
      await walkSearch(childAbs, childRel, query, glob, ignore, hits, state);
      continue;
    }
    await scanFile(childAbs, childRel, query, glob, hits, state);
  }
}

async function scanFile(
  absolute: string,
  relativePosix: string,
  query: string,
  glob: string | undefined,
  hits: string[],
  state: SearchState,
): Promise<void> {
  if (glob && !matchGlob(relativePosix, glob)) return;
  if (state.scanned >= MAX_SEARCH_FILES || hits.length >= MAX_SEARCH_HITS) {
    state.truncated = true;
    return;
  }
  state.scanned++;
  const file = await readFile(absolute);
  if (file.includes(0) || file.length > MAX_SEARCH_FILE_BYTES) return;
  const needle = query.toLowerCase();
  const lines = file.toString("utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").toLowerCase().includes(needle)) {
      hits.push(
        `${relativePosix}:${i + 1}: ${(lines[i] ?? "").trim().slice(0, 200)}`,
      );
      if (hits.length >= MAX_SEARCH_HITS) {
        state.truncated = true;
        return;
      }
    }
  }
}
