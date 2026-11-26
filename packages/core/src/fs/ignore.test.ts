import { test } from "node:test";
import assert from "node:assert/strict";
import { IgnoreSet, matchGlob } from "./ignore";

test("gitignore: каталоги, маски, отрицание, вложенный файл", () => {
  const ignore = new IgnoreSet();
  ignore.addFile(
    `
# комментарий
node_modules/
*.log
.env
.env.*
!.env.example
dist/
`,
    "",
  );

  assert.equal(ignore.denies("node_modules", true), true);
  assert.equal(ignore.denies("src/index.ts", false), false);
  assert.equal(ignore.denies("noise.log", false), true);
  assert.equal(ignore.denies("pkg/noise.log", false), true);
  assert.equal(ignore.denies(".env", false), true);
  assert.equal(ignore.denies(".env.local", false), true);
  assert.equal(ignore.denies(".env.example", false), false);
  assert.equal(ignore.denies("dist", true), true);
});

test("gitignore вложенного каталога не задевает соседей", () => {
  const ignore = new IgnoreSet();
  ignore.addFile("secret.txt\n", "pkg");
  assert.equal(ignore.denies("pkg/secret.txt", false), true);
  assert.equal(ignore.denies("secret.txt", false), false);
  assert.equal(ignore.denies("other/secret.txt", false), false);
});

test("matchGlob: имя и путь", () => {
  assert.equal(matchGlob("src/app.ts", "*.ts"), true);
  assert.equal(matchGlob("src/app.ts", "*.md"), false);
  assert.equal(matchGlob("docs/PLAN.md", "docs/*.md"), true);
  assert.equal(matchGlob("docs/sub/PLAN.md", "docs/*.md"), false);
  assert.equal(matchGlob("docs/sub/PLAN.md", "**/*.md"), true);
});
