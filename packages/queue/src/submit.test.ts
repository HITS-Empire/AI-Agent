import { test } from "node:test";
import assert from "node:assert/strict";
import { ownerSession, reduceTurn, type TurnState } from "./submit";

test("ownerSession: одна сессия на владельца", () => {
  const previousOwner = process.env.BURMALDA_OWNER_ID;
  const previousSession = process.env.BURMALDA_SESSION_ID;
  delete process.env.BURMALDA_OWNER_ID;
  delete process.env.BURMALDA_SESSION_ID;
  try {
    assert.deepEqual(ownerSession(), {
      ownerId: "owner",
      sessionId: "owner:main",
    });
    process.env.BURMALDA_OWNER_ID = "alex";
    assert.equal(ownerSession().sessionId, "alex:main");
  } finally {
    if (previousOwner === undefined) delete process.env.BURMALDA_OWNER_ID;
    else process.env.BURMALDA_OWNER_ID = previousOwner;
    if (previousSession === undefined) delete process.env.BURMALDA_SESSION_ID;
    else process.env.BURMALDA_SESSION_ID = previousSession;
  }
});

test("reduceTurn: сообщение и done, чужая задача не мешает", () => {
  const start: TurnState = { taskId: "t1", text: "", status: "running" };
  const withText = reduceTurn(start, {
    type: "message",
    taskId: "t1",
    text: "готово",
  });
  const ignored = reduceTurn(withText, {
    type: "message",
    taskId: "t2",
    text: "чужое",
  });
  const done = reduceTurn(ignored, { type: "done", taskId: "t1" });
  assert.equal(done.status, "done");
  assert.equal(done.text, "готово");

  const failed = reduceTurn(start, {
    type: "error",
    taskId: "t1",
    text: "упало",
  });
  assert.equal(failed.status, "error");
  assert.equal(failed.error, "упало");
});
