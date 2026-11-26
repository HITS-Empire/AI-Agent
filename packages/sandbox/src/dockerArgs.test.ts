import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  sandboxContainerName,
  sandboxCreateArgs,
  sandboxExecArgs,
  secretMasks,
} from "./dockerArgs";

test("docker run: изоляция, лимиты, без docker.sock и без секретов в окружении", () => {
  const args = sandboxCreateArgs({
    image: "burmalda-sandbox:local",
    name: "burmalda-sb-test",
    workspaceDir: "/work/repo",
    uid: 1000,
    gid: 1000,
    masks: [
      { hostPath: "/dev/null", containerPath: "/workspace/.env" },
      { hostPath: "/tmp/empty-mask", containerPath: "/workspace/.secrets" },
    ],
  });
  const text = args.join("\n");
  assert.match(text, /--network\nnone/);
  assert.match(text, /--read-only/);
  assert.match(text, /--cap-drop\nALL/);
  assert.match(text, /--pids-limit\n256/);
  assert.match(text, /--memory\n1g/);
  assert.match(text, /--cpus\n1/);
  assert.match(text, /no-new-privileges:true/);
  assert.match(text, /--user\n1000:1000/);
  assert.match(text, /\/work\/repo:\/workspace:rw/);
  assert.match(text, /\/dev\/null:\/workspace\/\.env:ro/);
  assert.match(text, /\/tmp\/empty-mask:\/workspace\/\.secrets:ro/);
  assert.equal(text.includes("docker.sock"), false);
  assert.equal(text.includes("LITELLM"), false);
  assert.equal(text.includes("DATABASE_URL"), false);
  const env = args.filter(
    (arg) =>
      arg.startsWith("HOME=") ||
      arg.startsWith("LANG=") ||
      arg.startsWith("PATH="),
  );
  assert.deepEqual(env, [
    "HOME=/tmp",
    "LANG=C.UTF-8",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  ]);
  assert.deepEqual(args.slice(-3), [
    "burmalda-sandbox:local",
    "sleep",
    "infinity",
  ]);
});

test("docker exec ограничивает команду timeout и не ходит через оболочку хоста", () => {
  const args = sandboxExecArgs(
    "burmalda-sb-test",
    1000,
    1000,
    "echo привет",
    30,
  );
  assert.deepEqual(args.slice(0, 2), ["exec", "-u"]);
  assert.ok(args.includes("timeout"));
  assert.equal(args.at(-1), "echo привет");
  assert.equal(args.includes("-lc"), true);
});

test("имя контейнера стабильно и без двоеточий из sessionId", () => {
  const name = sandboxContainerName("owner:main");
  assert.equal(name, sandboxContainerName("owner:main"));
  assert.match(name, /^burmalda-sb-[a-zA-Z0-9_.-]+$/);
  assert.equal(name.includes(":"), false);
});

test("маски секретов не указывают на сами файлы", async () => {
  const root = await mkdtemp(join(tmpdir(), "burmalda-mask-"));
  try {
    await writeFile(join(root, ".env"), "TOKEN=secret");
    await writeFile(join(root, ".env.example"), "TOKEN=");
    await mkdir(join(root, ".secrets"), { recursive: true });
    await writeFile(join(root, ".secrets", "key"), "k");
    const masks = await secretMasks(root);
    const targets = masks.map((mask) => mask.containerPath).sort();
    assert.deepEqual(targets, ["/workspace/.env", "/workspace/.secrets"]);
    for (const mask of masks) {
      assert.equal(mask.hostPath.endsWith(".env"), false);
      assert.equal(mask.hostPath.includes(".secrets"), false);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
