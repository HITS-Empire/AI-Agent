import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectHostShell } from "./types";
import {
  commandTouchesSecrets,
  createHostRunner,
  hostInvocation,
  parsePwshMajor,
  sanitizedEnv,
} from "./host";

test("detectHostShell: Windows pwsh, macOS zsh, Linux bash", () => {
  assert.equal(detectHostShell("win32"), "pwsh");
  assert.equal(detectHostShell("darwin"), "zsh");
  assert.equal(detectHostShell("linux"), "bash");
});

test("parsePwshMajor отличает PowerShell 7 от Windows PowerShell 5.1", () => {
  assert.equal(parsePwshMajor("PowerShell 7.4.6\n"), 7);
  assert.equal(parsePwshMajor("7.5.0"), 7);
  assert.equal(parsePwshMajor("5.1.19041.1"), 5);
  assert.equal(parsePwshMajor("нет"), null);
});

test("hostInvocation: bash -lc, zsh -lc, pwsh -NoProfile с UTF-8", () => {
  assert.deepEqual(hostInvocation("bash", "echo hi"), {
    cmd: "bash",
    args: ["-lc", "echo hi"],
  });
  assert.deepEqual(hostInvocation("zsh", "echo hi"), {
    cmd: "zsh",
    args: ["-lc", "echo hi"],
  });
  const pwsh = hostInvocation("pwsh", "echo hi");
  assert.equal(pwsh.cmd, "pwsh");
  assert.deepEqual(pwsh.args.slice(0, 3), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.match(pwsh.args[3] ?? "", /UTF8Encoding/);
  assert.match(pwsh.args[3] ?? "", /echo hi/);
});

test("sanitizedEnv вырезает ключи и DATABASE_URL, PATH оставляет", () => {
  const env = sanitizedEnv({
    PATH: "/usr/bin",
    LITELLM_API_KEY: "sk-secret",
    TELEGRAM_BOT_TOKEN: "123:abc",
    CALDAV_PASSWORD: "p",
    DATABASE_URL: "postgresql://burmalda:burmalda@localhost/db",
    HOME: "/tmp",
  });
  assert.equal(env.PATH, "/usr/bin");
  assert.equal(env.HOME, "/tmp");
  assert.equal(env.LITELLM_API_KEY, undefined);
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.CALDAV_PASSWORD, undefined);
  assert.equal(env.DATABASE_URL, undefined);
});

test("commandTouchesSecrets: .env и ключи, но не .env.example", () => {
  assert.equal(commandTouchesSecrets("echo ok"), false);
  assert.equal(commandTouchesSecrets("cat .env.example"), false);
  assert.equal(commandTouchesSecrets("cat .env"), true);
  assert.equal(commandTouchesSecrets("cat .env.local"), true);
  assert.equal(commandTouchesSecrets("ls .secrets"), true);
  assert.equal(commandTouchesSecrets("cat auth.json"), true);
});

function hasBin(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(bin, ["--version"], { stdio: "ignore" });
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

const bashOk = await hasBin("bash");
const pwshOk = await hasBin("pwsh");
const zshOk = await hasBin("zsh");

test(
  "bash: юникод, таймаут убивает дерево, секреты не читаются и не видны в env",
  { skip: !bashOk && "bash не установлен" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "burmalda-sh-"));
    const previous = process.env.LITELLM_API_KEY;
    process.env.LITELLM_API_KEY = "sk-test-secret";
    try {
      const runner = createHostRunner("bash");
      const hello = await runner.run("echo привет", { cwd: root });
      assert.equal(hello.exitCode, 0);
      assert.equal(hello.timedOut, false);
      assert.match(hello.stdout, /привет/);
      assert.equal(runner.shellName, "bash");

      const leaked = await runner.run("printenv LITELLM_API_KEY || true", {
        cwd: root,
      });
      assert.equal(leaked.exitCode, 0);
      assert.equal(leaked.stdout.trim(), "");

      await assert.rejects(runner.run("cat .env", { cwd: root }), /секрет/);

      const marker = join(root, "leaked");
      const hung = await runner.run(
        `(sleep 0.7; echo leaked > '${marker}') & sleep 3`,
        { cwd: root, timeoutMs: 200 },
      );
      assert.equal(hung.timedOut, true);
      await new Promise((resolve) => setTimeout(resolve, 900));
      assert.equal(existsSync(marker), false);
    } finally {
      if (previous === undefined) delete process.env.LITELLM_API_KEY;
      else process.env.LITELLM_API_KEY = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "pwsh: версия не ниже 7 и юникод",
  { skip: !pwshOk && "pwsh не установлен" },
  async () => {
    const runner = createHostRunner("pwsh");
    const result = await runner.run("Write-Output 'привет'");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /привет/);
    assert.match(runner.shellName, /^pwsh [7-9]/);
  },
);

test(
  "zsh запускается, если он есть",
  { skip: !zshOk && "zsh не установлен" },
  async () => {
    const runner = createHostRunner("zsh");
    const result = await runner.run("echo привет");
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /привет/);
    assert.equal(runner.shellName, "zsh");
  },
);
