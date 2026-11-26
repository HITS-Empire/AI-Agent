import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fsTools } from "./fs";
import { loadSkillTool } from "./skills";
import type { Tool, ToolContext } from "./types";

function tool(name: string): Tool {
  const found = fsTools().find((item) => item.name === name);
  if (!found) throw new Error(name);
  return found;
}

function ctx(root: string, approve = false): ToolContext {
  return {
    sessionId: "s",
    taskId: "t",
    workspaceRoot: root,
    requestApproval: async () => approve,
  };
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test("read/write/edit: диапазон строк и уникальная замена", async () => {
  const root = await tempDir("burmalda-fs-");
  try {
    const written = await tool("write_file").execute(
      { path: "docs/a.txt", content: "альфа\nбета\nальфа\n" },
      ctx(root),
    );
    assert.match(written, /записано docs\/a\.txt/);

    const ranged = await tool("read_file").execute(
      { path: "docs/a.txt", start_line: 2, end_line: 2 },
      ctx(root),
    );
    assert.match(ranged, /2\|бета/);
    assert.doesNotMatch(ranged, /альфа/);

    await assert.rejects(
      tool("edit_file").execute(
        { path: "docs/a.txt", old: "альфа", new: "гамма" },
        ctx(root),
      ),
      /2 раз/,
    );
    const edited = await tool("edit_file").execute(
      { path: "docs/a.txt", old: "бета", new: "гамма" },
      ctx(root),
    );
    assert.match(edited, /обновлено/);
    assert.equal(
      await readFile(join(root, "docs", "a.txt"), "utf8"),
      "альфа\nгамма\nальфа\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("выход за workspace: .. и симлинк требуют подтверждения, секреты закрыты", async () => {
  const root = await tempDir("burmalda-fs-");
  const outside = await tempDir("burmalda-out-");
  try {
    await writeFile(join(outside, "note.txt"), "снаружи");
    await writeFile(join(root, ".env"), "TOKEN=secret");
    await mkdir(join(root, ".secrets"), { recursive: true });
    await writeFile(join(root, ".secrets", "key"), "k");

    await assert.rejects(
      tool("read_file").execute({ path: "../note.txt" }, ctx(root, false)),
      /workspace/,
    );
    await assert.rejects(
      tool("read_file").execute({ path: ".env" }, ctx(root, true)),
      /секрет/,
    );
    await assert.rejects(
      tool("read_file").execute({ path: ".secrets/key" }, ctx(root, true)),
      /секрет/,
    );

    const approved = await tool("read_file").execute(
      { path: join(outside, "note.txt") },
      ctx(root, true),
    );
    assert.match(approved, /снаружи/);

    try {
      await symlink(join(outside, "note.txt"), join(root, "leak.txt"));
    } catch {
      return;
    }
    await assert.rejects(
      tool("read_file").execute({ path: "leak.txt" }, ctx(root, false)),
      /workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("list_dir: дерево, .gitignore и секреты", async () => {
  const root = await tempDir("burmalda-tree-");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, ".gitignore"),
      "node_modules/\n*.log\n.env\n.env.*\n!.env.example\n",
    );
    await writeFile(join(root, "src", "app.ts"), "export {}\n");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "x");
    await writeFile(join(root, "noise.log"), "log");
    await writeFile(join(root, ".env"), "SECRET=1");
    await writeFile(join(root, ".env.example"), "SECRET=\n");
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git", "HEAD"), "ref");

    const tree = await tool("list_dir").execute(
      { path: ".", depth: 3 },
      ctx(root),
    );
    assert.match(tree, /src\//);
    assert.match(tree, /app\.ts/);
    assert.match(tree, /\.env\.example/);
    assert.doesNotMatch(tree, /node_modules/);
    assert.doesNotMatch(tree, /noise\.log/);
    assert.doesNotMatch(tree, /\.env(?!\.example)/);
    assert.doesNotMatch(tree, /\.git\//);
    assert.doesNotMatch(tree, /HEAD/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("search_files ищет по тексту и уважает glob", async () => {
  const root = await tempDir("burmalda-search-");
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "app.ts"), "const token = 1;\n");
    await writeFile(join(root, "note.md"), "token в заметке\n");
    await writeFile(join(root, ".gitignore"), "");
    const hits = await tool("search_files").execute(
      { query: "token", glob: "*.ts" },
      ctx(root),
    );
    assert.match(hits, /src\/app\.ts:1:/);
    assert.doesNotMatch(hits, /note\.md/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_skill возвращает тело без frontmatter", async () => {
  const root = await tempDir("burmalda-load-");
  try {
    await mkdir(join(root, "demo"), { recursive: true });
    await writeFile(
      join(root, "demo", "SKILL.md"),
      "---\nname: demo\ndescription: пример\n---\n\n# Делай раз\n",
    );
    const result = await loadSkillTool([root]).execute(
      { name: "demo" },
      ctx(root),
    );
    assert.equal(result, "# Делай раз");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
