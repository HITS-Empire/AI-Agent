import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertHttpUrl,
  formatCommandResult,
  osInfoTool,
  shellTool,
  type CommandRunner,
} from "./os";
import type { ToolContext } from "./types";

function runner(kind: CommandRunner["kind"] = "sandbox"): CommandRunner & {
  commands: string[];
} {
  const commands: string[] = [];
  return {
    kind,
    shellName: kind === "host" ? "bash" : "bash (docker)",
    commands,
    async run(command) {
      commands.push(command);
      return { exitCode: 0, stdout: "ok\n", stderr: "", timedOut: false };
    },
  };
}

function ctx(approve = false): ToolContext {
  return {
    sessionId: "s",
    taskId: "t",
    workspaceRoot: "/workspace",
    requestApproval: async () => approve,
  };
}

test("shell в песочнице не спрашивает подтверждение и показывает код", async () => {
  const fake = runner("sandbox");
  const tool = shellTool({ getRunner: () => fake });
  assert.equal(tool.dangerous, false);
  const text = await tool.execute({ command: "echo ok" }, ctx());
  assert.deepEqual(fake.commands, ["echo ok"]);
  assert.match(text, /bash \(docker\) · код 0/);
  assert.match(text, /ok/);
});

test("shell на хосте без флага dangerous всё равно спрашивает владельца", async () => {
  const fake = runner("host");
  const tool = shellTool({ getRunner: () => fake, host: false });
  await assert.rejects(
    tool.execute({ command: "echo hi" }, ctx(false)),
    /не подтвердил/,
  );
  assert.deepEqual(fake.commands, []);
  const text = await tool.execute({ command: "echo hi" }, ctx(true));
  assert.match(text, /код 0/);
});

test("host-режим помечает shell как dangerous", () => {
  const tool = shellTool({ getRunner: () => runner("host"), host: true });
  assert.equal(tool.dangerous, true);
});

test("os_info — JSON без домашних путей", async () => {
  const text = await osInfoTool("bash").execute({}, ctx());
  const info = JSON.parse(text) as { shell: string; platform: string };
  assert.equal(info.shell, "bash");
  assert.ok(info.platform);
  assert.equal(text.includes("home"), false);
});

test("assertHttpUrl отвергает file и принимает https", () => {
  assert.equal(assertHttpUrl("https://example.com/a").hostname, "example.com");
  assert.throws(() => assertHttpUrl("file:///etc/passwd"), /http/);
  assert.throws(() => assertHttpUrl("not a url"), /непонятный/);
});

test("formatCommandResult показывает stderr и таймаут", () => {
  const text = formatCommandResult("zsh", {
    exitCode: 124,
    stdout: "",
    stderr: "boom",
    timedOut: true,
  });
  assert.match(text, /zsh · таймаут, код 124/);
  assert.match(text, /stderr:\nboom/);
});
