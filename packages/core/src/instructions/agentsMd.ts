import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isEnoent, isOutside, toPosix } from "../fs/paths";

export interface AgentsMdFile {
  path: string;
  content: string;
}

/**
 * Стандарт AGENTS.md (https://agents.md): файлы от корня workspace до cwd.
 * Порядок — «общий → частный»: более глубокий файл идёт позже и в system prompt приоритетнее.
 * Симлинк на AGENTS.md за пределами workspace пропускается.
 */
export async function collectAgentsMd(
  workspaceRoot: string,
  cwd: string,
): Promise<AgentsMdFile[]> {
  const root = await realpath(resolve(workspaceRoot));
  const target = resolve(cwd);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`cwd вне workspace: ${cwd}`);
  }

  const dirs = [root];
  if (rel) {
    let acc = root;
    for (const part of rel.split(sep)) {
      if (!part || part === ".") continue;
      acc = join(acc, part);
      dirs.push(acc);
    }
  }

  const files: AgentsMdFile[] = [];
  for (const dir of dirs) {
    const filePath = join(dir, "AGENTS.md");
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    let realFile: string;
    try {
      realFile = await realpath(filePath);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    if (isOutside(root, realFile)) continue;
    const shown = toPosix(relative(root, filePath)) || "AGENTS.md";
    files.push({ path: shown, content });
  }
  return files;
}
