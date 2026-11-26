/**
 * Подмножество gitignore для дерева каталога: комментарии, `*`, `?`, `**`,
 * якорь `/`, каталоги с `/` на конце, отрицание `!`. Последнее совпавшее правило побеждает.
 * Полный синтаксис git (экранирование пробелов, `**` в середине каждого краевого случая) не нужен:
 * хватает правил из нашего .gitignore и обычных проектов.
 */

interface IgnoreRule {
  negated: boolean;
  directoryOnly: boolean;
  /** true — шаблон сравнивается со всем путём от каталога .gitignore, иначе только с именем. */
  matchPath: boolean;
  /** Каталог .gitignore относительно корня workspace, через `/`. Пусто — корень. */
  base: string;
  regex: RegExp;
}

export class IgnoreSet {
  private readonly rules: IgnoreRule[] = [];

  addFile(content: string, basePosix = ""): void {
    this.rules.push(...parseGitignore(content, basePosix));
  }

  /**
   * relativePosix — путь от корня workspace, без ведущего `./`.
   * Каталог, который исключён, не раскрываем: git не включает файл заново, если исключён его родитель.
   */
  denies(relativePosix: string, isDir: boolean): boolean {
    let denied = false;
    for (const rule of this.rules) {
      if (rule.directoryOnly && !isDir) continue;
      let rel = relativePosix;
      if (rule.base) {
        if (
          relativePosix === rule.base ||
          !relativePosix.startsWith(`${rule.base}/`)
        ) {
          continue;
        }
        rel = relativePosix.slice(rule.base.length + 1);
      }
      const target = rule.matchPath ? rel : (rel.split("/").pop() ?? rel);
      if (rule.regex.test(target)) denied = !rule.negated;
    }
    return denied;
  }
}

export function parseGitignore(content: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of content.split(/\r?\n/)) {
    if (!raw || raw.startsWith("#") || raw.trim() === "") continue;
    let line = raw.trim();
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    let directoryOnly = false;
    if (line.endsWith("/")) {
      directoryOnly = true;
      line = line.slice(0, -1);
    }
    const anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (!line) continue;
    const matchPath = anchored || line.includes("/");
    rules.push({
      negated,
      directoryOnly,
      matchPath,
      base,
      regex: globToRegExp(line),
    });
  }
  return rules;
}

/** Мини-glob: `*` не переходит через `/`, `**` переходит. */
export function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    if ("\\^$+?.()|{}[]".includes(char)) source += `\\${char}`;
    else source += char;
  }
  return new RegExp(`^${source}$`);
}

export function matchGlob(relativePosix: string, glob: string): boolean {
  const pattern = glob.split(/[\\/]/).join("/");
  if (!pattern.includes("/")) {
    const base = relativePosix.split("/").pop() ?? relativePosix;
    return globToRegExp(pattern).test(base);
  }
  return globToRegExp(pattern).test(relativePosix);
}
