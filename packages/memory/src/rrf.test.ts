import { test } from "node:test";
import assert from "node:assert/strict";
import { rrfFuse, toPgVector } from "./rrf";
import { parseFactList } from "./extractFacts";
import { sanitizeHistory } from "./shortTerm";

test("rrfFuse: документ из нескольких списков поднимается выше", () => {
  const fused = rrfFuse([
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    [{ id: "c" }, { id: "a" }],
    [{ id: "c" }],
  ]);
  assert.deepEqual(
    fused.map((f) => f.id),
    ["c", "a", "b"],
  );
  assert.ok(fused[0]!.score > fused[1]!.score);
});

test("toPgVector: формат pgvector и защита от NaN", () => {
  assert.equal(toPgVector([0.5, NaN, -1]), "[0.5,0,-1]");
});

test("parseFactList: JSON в обёртке, мусор, ограничения", () => {
  assert.deepEqual(
    parseFactList('```json\n["Владелец пьёт кофе без сахара", 5, "ok"]\n```'),
    ["Владелец пьёт кофе без сахара"],
  );
  assert.deepEqual(parseFactList("фактов нет"), []);
  assert.deepEqual(parseFactList("[битый"), []);
});

test("sanitizeHistory: убирает tool без вызова и вызовы без ответа", () => {
  const cleaned = sanitizeHistory([
    { role: "user", content: "x" },
    {
      role: "assistant",
      content: "думаю",
      tool_calls: [
        { id: "a", type: "function", function: { name: "t", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "t", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "a", content: "ok" },
    { role: "tool", tool_call_id: "zzz", content: "сирота" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "c", type: "function", function: { name: "t", arguments: "{}" } },
      ],
    },
  ]);
  assert.deepEqual(
    cleaned.map((m) => m.role),
    ["user", "assistant", "tool"],
  );
  const assistant = cleaned[1] as { tool_calls: Array<{ id: string }> };
  assert.deepEqual(
    assistant.tool_calls.map((c) => c.id),
    ["a"],
  );
});
