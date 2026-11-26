import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCommandAllowed, commandNames } from "./allowlist";

test("allowlist видит команды в конвейере, && и подстановке", () => {
  assert.deepEqual(commandNames("echo hi | wc -l"), ["echo", "wc"]);
  assert.deepEqual(commandNames("ls && git status"), ["ls", "git"]);
  assert.deepEqual(commandNames("echo $(whoami)"), ["echo", "whoami"]);
  assert.deepEqual(commandNames("FOO=1 ls"), ["ls"]);
  assert.ok(commandNames("rm -rf /tmp/x").includes("rm"));
});

test("allowlist пропускает обычные команды и отвергает обход", () => {
  assert.doesNotThrow(() => assertCommandAllowed("echo привет && ls"));
  assert.doesNotThrow(() =>
    assertCommandAllowed("rm -rf /tmp/nowhere || true"),
  );
  assert.throws(() => assertCommandAllowed("docker ps"), /allowlist/);
  assert.throws(() => assertCommandAllowed("eval echo hi"), /allowlist/);
  assert.throws(() => assertCommandAllowed("echo $(sudo id)"), /allowlist/);
  assert.throws(
    () => assertCommandAllowed("echo ok # comment\ndocker ps"),
    /allowlist/,
  );
  assert.throws(() => assertCommandAllowed("cat .env"), /секрет/);
  assert.doesNotThrow(() => assertCommandAllowed("cat .env.example"));
});
