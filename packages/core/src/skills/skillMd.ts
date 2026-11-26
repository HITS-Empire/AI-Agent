import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent } from "../fs/paths";

export interface SkillMeta {
  name: string;
  description: string;
  /** Путь к SKILL.md; тело читается лениво инструментом load_skill. */
  path: string;
}

export interface ParsedSkill {
  name: string;
  description: string;
  /** Тело без YAML-frontmatter. */
  body: string;
}

/**
 * Свой разбор frontmatter SKILL.md: библиотеку YAML в ядро тащить нельзя.
 * Поддерживаются `key: value`, кавычки и блоки `|` / `>`. Остальной YAML не нужен —
 * у навыков только name и description.
 */
export function parseSkillMarkdown(
  raw: string,
  fallbackName: string,
): ParsedSkill {
  const text = raw.replace(/^\uFEFF/, "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    return {
      name: fallbackName,
      description: "",
      body: text.trim(),
    };
  }
  const fields = parseFrontmatter(match[1] ?? "");
  const name = fields.name?.trim() || fallbackName;
  const description = (fields.description ?? "").trim();
  return { name, description, body: (match[2] ?? "").trim() };
}

/**
 * Найти `<dir>/<skill>/SKILL.md`. В промпт попадают только name и description.
 * Повтор имени (первый каталог в списке побеждает) пропускается.
 */
export async function discoverSkills(dirs: string[]): Promise<SkillMeta[]> {
  const found: SkillMeta[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(dir, entry.name, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(skillPath, "utf8");
      } catch (error) {
        if (isEnoent(error)) continue;
        throw error;
      }
      const parsed = parseSkillMarkdown(raw, entry.name);
      if (seen.has(parsed.name)) continue;
      seen.add(parsed.name);
      found.push({
        name: parsed.name,
        description: parsed.description,
        path: skillPath,
      });
    }
  }
  found.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return found;
}

/** Тело навыка без frontmatter. Неизвестный name — ошибка со списком доступных. */
export async function readSkillBody(
  dirs: string[],
  name: string,
): Promise<string> {
  const skills = await discoverSkills(dirs);
  const skill = skills.find((item) => item.name === name);
  if (!skill) {
    const names = skills.map((item) => item.name).join(", ") || "нет";
    throw new Error(`Навык «${name}» не найден. Доступны: ${names}`);
  }
  const raw = await readFile(skill.path, "utf8");
  const body = parseSkillMarkdown(raw, name).body;
  return body || "(пустой навык)";
}

function parseFrontmatter(yaml: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const header = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!header) continue;
    const key = header[1]!;
    const rest = (header[2] ?? "").trim();
    if (rest === "|" || rest === ">") {
      const block: string[] = [];
      while (i + 1 < lines.length && /^( {2,}|\t)/.test(lines[i + 1] ?? "")) {
        i++;
        block.push((lines[i] ?? "").replace(/^( {2}|\t)/, ""));
      }
      fields[key] =
        rest === "|" ? block.join("\n").trim() : block.join(" ").trim();
      continue;
    }
    fields[key] = unquote(rest);
  }
  return fields;
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
