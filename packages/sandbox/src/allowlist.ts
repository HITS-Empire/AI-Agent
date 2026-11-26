import { commandTouchesSecrets } from "./host";

/**
 * Команды, которые песочница согласна запустить. Всё остальное — отказ до docker exec.
 * `eval` / `source` / `exec` запрещены отдельно: ими allowlist обходится.
 */
export const DEFAULT_ALLOWLIST = [
  "awk",
  "base64",
  "basename",
  "bash",
  "cat",
  "chmod",
  "comm",
  "corepack",
  "cp",
  "curl",
  "cut",
  "date",
  "diff",
  "dirname",
  "du",
  "echo",
  "env",
  "eslint",
  "false",
  "file",
  "find",
  "fold",
  "git",
  "grep",
  "gunzip",
  "gzip",
  "head",
  "id",
  "jq",
  "less",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "nl",
  "node",
  "npm",
  "npx",
  "pnpm",
  "prettier",
  "printenv",
  "printf",
  "ps",
  "pwd",
  "python",
  "python3",
  "realpath",
  "rg",
  "rm",
  "sed",
  "seq",
  "sh",
  "sleep",
  "sort",
  "stat",
  "tail",
  "tar",
  "tee",
  "test",
  "timeout",
  "touch",
  "tr",
  "tree",
  "true",
  "tsc",
  "tsx",
  "uname",
  "uniq",
  "unzip",
  "wc",
  "which",
  "whoami",
  "xargs",
  "[",
] as const;

const BUILTINS = new Set([
  ":",
  "[",
  "alias",
  "break",
  "case",
  "cd",
  "continue",
  "declare",
  "do",
  "done",
  "echo",
  "elif",
  "else",
  "esac",
  "exit",
  "export",
  "false",
  "fi",
  "for",
  "function",
  "getopts",
  "hash",
  "help",
  "if",
  "in",
  "let",
  "local",
  "printf",
  "pushd",
  "popd",
  "pwd",
  "read",
  "readonly",
  "return",
  "set",
  "shift",
  "test",
  "then",
  "times",
  "trap",
  "true",
  "type",
  "typeset",
  "ulimit",
  "umask",
  "unalias",
  "unset",
  "until",
  "wait",
  "while",
]);

const DENIED = new Set([
  ".",
  "builtin",
  "chroot",
  "command",
  "docker",
  "eval",
  "exec",
  "mount",
  "nc",
  "ncat",
  "nsenter",
  "scp",
  "socat",
  "source",
  "ssh",
  "su",
  "sudo",
  "umount",
]);

/** Проверить команду до запуска. Бросает, если есть секрет или имя вне allowlist. */
export function assertCommandAllowed(
  command: string,
  allowlist: readonly string[] = DEFAULT_ALLOWLIST,
): void {
  if (commandTouchesSecrets(command)) {
    throw new Error(
      "команда обращается к секретам (.env, .secrets, ключи) — отказ",
    );
  }
  const allowed = new Set<string>([...allowlist, ...BUILTINS]);
  for (const name of commandNames(command)) {
    const base = name.split(/[\\/]/).pop() ?? name;
    if (DENIED.has(base) || !allowed.has(base)) {
      throw new Error(`команда «${base}» не входит в allowlist песочницы`);
    }
  }
}

/** Имена внешних команд и подстановок `$(...)` / бэктики, без слов в кавычках-аргументах. */
export function commandNames(script: string): string[] {
  const names: string[] = [];
  const visit = (source: string) => {
    const { stripped, nested } = extractSubstitutions(source);
    for (const segment of splitSegments(stripped)) {
      const name = firstCommand(segment);
      if (name) names.push(name);
    }
    for (const inner of nested) visit(inner);
  };
  visit(script);
  return names;
}

function extractSubstitutions(script: string): {
  stripped: string;
  nested: string[];
} {
  const nested: string[] = [];
  let stripped = "";
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (ch === "`") {
      const end = script.indexOf("`", i + 1);
      if (end === -1) throw new Error("незакрытая подстановка `");
      nested.push(script.slice(i + 1, end));
      stripped += " ";
      i = end;
      continue;
    }
    if (ch === "$" && script[i + 1] === "(") {
      const inner = readBalanced(script, i + 2);
      nested.push(inner.body);
      stripped += " ";
      i = inner.end;
      continue;
    }
    stripped += ch;
  }
  return { stripped, nested };
}

function readBalanced(
  script: string,
  start: number,
): { body: string; end: number } {
  let depth = 1;
  let quote: "'" | '"' | null = null;
  for (let i = start; i < script.length; i++) {
    const ch = script[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < script.length) {
        i++;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    if (ch === ")") {
      depth--;
      if (depth === 0) return { body: script.slice(start, i), end: i };
    }
  }
  throw new Error("незакрытая подстановка $()");
}

function splitSegments(script: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (current.trim()) parts.push(current);
    current = "";
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      current += ch;
      if (ch === "\\" && script[i + 1] !== undefined) {
        current += script[++i];
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "#") {
      // комментарий до конца строки, следующие команды всё равно проверяем
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    const two = script.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      push();
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === "\n") {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return parts;
}

function firstCommand(segment: string): string | null {
  const tokens = tokenize(segment);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue;
    if (
      token === ">" ||
      token === ">>" ||
      token === "<" ||
      token === "&>" ||
      /^\d*>{1,2}$/.test(token) ||
      /^\d*<$/.test(token) ||
      /^\d*>&?\d*$/.test(token)
    ) {
      i++;
      continue;
    }
    return stripQuotes(token);
  }
  return null;
}

function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (current) tokens.push(current);
    current = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && segment[i + 1] !== undefined) {
        current += segment[++i];
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    current += ch;
  }
  push();
  return tokens;
}

function stripQuotes(token: string): string {
  if (
    token.length >= 2 &&
    ((token.startsWith("'") && token.endsWith("'")) ||
      (token.startsWith('"') && token.endsWith('"')))
  ) {
    return token.slice(1, -1);
  }
  return token;
}
