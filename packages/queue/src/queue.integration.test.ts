import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@burmalda/shared";
import {
  EventBus,
  createAgentQueue,
  createAgentWorker,
  enqueueAgentTask,
  redisConnection,
} from "./index";
import { reduceTurn, type TurnState } from "./submit";

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

test(
  "задача из очереди возвращается событием в ту же сессию",
  { skip: !url && "нет TEST_REDIS_URL" },
  async () => {
    const name = `burmalda-test-${randomUUID()}`;
    const queue = createAgentQueue(url!, name);
    const bus = new EventBus(url!);
    const sessionId = `test:${randomUUID()}`;
    const events: AgentEvent[] = [];
    const unsubscribe = await bus.subscribe(sessionId, (event) =>
      events.push(event),
    );
    const worker = createAgentWorker(
      url!,
      async (task) => {
        await bus.publish(task.sessionId, {
          type: "message",
          taskId: task.taskId,
          text: `эхо ${task.text}`,
        });
        await bus.publish(task.sessionId, {
          type: "done",
          taskId: task.taskId,
        });
      },
      1,
      name,
    );
    try {
      const task = await enqueueAgentTask(queue, {
        sessionId,
        channel: "cli",
        text: "привет",
      });
      const start: TurnState = {
        taskId: task.taskId,
        text: "",
        status: "running",
      };
      let state = start;
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && state.status === "running") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = events.reduce(reduceTurn, start);
      }
      assert.equal(state.status, "done");
      assert.equal(state.text, "эхо привет");
    } finally {
      await worker.close();
      await queue.close();
      await unsubscribe();
      await bus.close();
    }
  },
);
