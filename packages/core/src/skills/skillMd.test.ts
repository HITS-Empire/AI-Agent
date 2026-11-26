import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { discoverSkills, parseSkillMarkdown, readSkillBody } from "./skillMd";

test("frontmatter без YAML-библиотеки: кавычки, блок и тело отдельно", () => {
  const parsed = parseSkillMarkdown(
    `---
name: demo
description: "Поиск: свежие факты"
---

# Заголовок

текст
`,
    "dir",
  );
  assert.equal(parsed.name, "demo");
  assert.equal(parsed.description, "Поиск: свежие факты");
  assert.equal(parsed.body, "# Заголовок\n\nтекст");

  const block = parseSkillMarkdown(
    "---\nname: block\ndescription: |\n  первая\n  вторая\n---\n\nтело\n",
    "dir",
  );
  assert.equal(block.description, "первая\nвторая");
  assert.equal(block.body, "тело");
});

test("discoverSkills читает только метаданные, тело — через readSkillBody", async () => {
  const root = await mkdtemp(join(tmpdir(), "burmalda-skills-"));
  try {
    await mkdir(join(root, "alpha"), { recursive: true });
    await mkdir(join(root, "beta"), { recursive: true });
    await writeFile(
      join(root, "alpha", "SKILL.md"),
      "---\nname: alpha\ndescription: первый\n---\n\n# Альфа\n",
    );
    await writeFile(
      join(root, "beta", "SKILL.md"),
      "---\nname: beta\ndescription: второй\n---\n\n# Бета\n",
    );
    await writeFile(join(root, "README.md"), "не навык");

    const skills = await discoverSkills([root]);
    assert.deepEqual(
      skills.map((skill) => skill.name),
      ["alpha", "beta"],
    );
    assert.equal(skills[0]?.description, "первый");
    const body = await readSkillBody([root], "alpha");
    assert.equal(body, "# Альфа");
    assert.doesNotMatch(body, /description/);
    await assert.rejects(readSkillBody([root], "нет"), /не найден/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("встроенные навыки репозитория: метаданные есть, тело грузится отдельно", async () => {
  const dir = resolve(import.meta.dirname, "../../../../skills");
  const skills = await discoverSkills([dir]);
  const names = skills.map((skill) => skill.name);
  for (const name of [
    "calendar",
    "github",
    "marketplace-search",
    "reminders",
    "web-search",
  ]) {
    assert.ok(names.includes(name), name);
    const meta = skills.find((skill) => skill.name === name);
    assert.ok(meta && meta.description.length > 10);
  }
  const body = await readSkillBody([dir], "web-search");
  assert.match(body, /^# Поиск/);
  assert.doesNotMatch(body, /^---/);
  assert.doesNotMatch(body, /^name:/);
});
