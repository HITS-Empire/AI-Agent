import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent } from "@burmalda/shared";
import { EventBus, redisConnection } from "./index";

const url = process.env.TEST_REDIS_URL;

test("redisConnection разбирает URL", () => {
  assert.deepEqual(redisConnection("redis://u:p%40ss@host:6380/2"), {
    host: "host",
    port: 6380,
    username: "u",
    password: "p@ss",
    db: 2,
  });
});

test(
  "EventBus: события сессии и подтверждения",
  { skip: !url && "нет TEST_REDIS_URL" },
  async () => {
    const bus = new EventBus(url!);
    const got: AgentEvent[] = [];
    const unsubscribe = await bus.subscribe("test:session", (e) => got.push(e));
    await bus.publish("test:session", {
      type: "message",
      taskId: "t",
      text: "привет",
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(got, [{ type: "message", taskId: "t", text: "привет" }]);

    const waiting = bus.waitApproval("req-1", 5);
    await bus.answerApproval("req-1", true);
    assert.equal(await waiting, true);
    assert.equal(await bus.waitApproval("req-2", 1), false);

    await unsubscribe();
    await bus.close();
  },
);
