import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSandboxRunner, stopAllSandboxes } from "./sandbox";

function dockerOk(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { stdio: "ignore" });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      resolve(ok);
    };
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
  });
}

const image = process.env.SANDBOX_IMAGE ?? "burmalda-sandbox:local";
const dockerReady = await dockerOk(["info"]);
const imageReady = dockerReady && (await dockerOk(["image", "inspect", image]));

test(
  "песочница: изоляция сети, маска .env, allowlist, rm не трогает хост",
  {
    skip:
      (!dockerReady && "нет docker") ||
      (!imageReady && `нет образа ${image} (pnpm sandbox:build)`),
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "burmalda-sb-"));
    const outside = join(tmpdir(), `burmalda-host-${Date.now()}`);
    await writeFile(outside, "host-ok");
    await writeFile(join(root, ".env"), "TOKEN=secret");
    await writeFile(join(root, "keep.txt"), "keep");
    const runner = createSandboxRunner({
      image,
      workspaceDir: root,
      sessionId: `it-${Date.now()}`,
    });
    try {
      const hello = await runner.run("echo привет && pwd");
      assert.equal(hello.exitCode, 0, hello.stderr);
      assert.match(hello.stdout, /привет/);
      assert.match(hello.stdout, /\/workspace/);

      await assert.rejects(runner.run("docker ps"), /allowlist/);

      const secret = await runner.run("cat .env || true");
      assert.equal(secret.stdout.includes("TOKEN=secret"), false);

      const net = await runner.run("curl -I https://example.com || true");
      assert.equal(/HTTP\/[12]/.test(net.stdout), false);

      const wiped = await runner.run("rm -rf / || true; cat keep.txt");
      assert.match(wiped.stdout, /keep/);
      assert.equal(await readFile(outside, "utf8"), "host-ok");
    } finally {
      await stopAllSandboxes();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { force: true });
    }
  },
);
