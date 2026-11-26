import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectAgentsMd } from "./agentsMd";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "burmalda-agents-"));
}

test("AGENTS.md: от общего к частному, более глубокий позже", async () => {
  const root = await tempDir();
  try {
    await mkdir(join(root, "pkg", "sub"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), "общий\n");
    await writeFile(join(root, "pkg", "AGENTS.md"), "частный\n");
    await writeFile(join(root, "pkg", "sub", "note.txt"), "не инструкция");

    const files = await collectAgentsMd(root, join(root, "pkg", "sub"));
    assert.deepEqual(
      files.map((file) => file.path),
      ["AGENTS.md", "pkg/AGENTS.md"],
    );
    assert.equal(files[0]?.content.trim(), "общий");
    assert.equal(files[1]?.content.trim(), "частный");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AGENTS.md: cwd вне workspace — ошибка, симлинк наружу пропускается", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  try {
    await writeFile(join(outside, "AGENTS.md"), "чужой");
    await assert.rejects(collectAgentsMd(root, outside), /вне workspace/);

    try {
      await symlink(join(outside, "AGENTS.md"), join(root, "AGENTS.md"));
    } catch {
      return;
    }
    const files = await collectAgentsMd(root, root);
    assert.deepEqual(files, []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
