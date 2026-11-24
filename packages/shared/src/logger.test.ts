import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import { createLogger } from "./logger";

test("логи — JSON-строки с service, уровнем, ISO-временем; секреты скрыты", () => {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, done) {
      lines.push(String(chunk));
      done();
    },
  });
  const log = createLogger("worker", "info", { destination });
  log.info(
    {
      sessionId: "owner:main",
      taskId: "t1",
      traceId: "abc",
      apiKey: "sk-secret",
      headers: { authorization: "Bearer x" },
    },
    "задача выполнена",
  );
  log.debug("не попадёт");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(entry.service, "worker");
  assert.equal(entry.level, "info");
  assert.equal(entry.msg, "задача выполнена");
  assert.equal(entry.traceId, "abc");
  assert.match(String(entry.time), /^\d{4}-\d\d-\d\dT/);
  assert.equal(entry.apiKey, "[redacted]");
  assert.deepEqual(entry.headers, { authorization: "[redacted]" });
  assert.ok(!lines[0]!.includes("sk-secret"));
});
