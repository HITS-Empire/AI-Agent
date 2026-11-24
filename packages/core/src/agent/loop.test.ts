import { test } from "node:test";
import assert from "node:assert/strict";
import { runAgent, type AgentLoopEvent } from "./loop";
import { FakeLlmClient } from "../llm/fakeClient";
import { ToolRegistry } from "../tools/registry";
import type { ChatMessage } from "../llm/types";
import type { ToolContext } from "../tools/types";
import type { Span, Tracer } from "../observability/tracer";

const ctx = (approve = true): ToolContext => ({
  sessionId: "s1",
  taskId: "t1",
  workspaceRoot: "/tmp",
  requestApproval: async () => approve,
});

function registryWithEcho(log: string[] = []): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "echo",
    description: "Повторяет текст",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args: { text: string }) => {
      log.push(args.text);
      return `эхо: ${args.text}`;
    },
  });
  return registry;
}

test("цикл: вызов инструмента → результат в истории → финальный ответ", async () => {
  const llm = new FakeLlmClient([
    {
      toolCalls: [{ name: "echo", args: { text: "раз" } }],
      usage: { prompt_tokens: 100, completion_tokens: 10 },
    },
    { text: "Готово", usage: { prompt_tokens: 150, completion_tokens: 5 } },
  ]);
  const log: string[] = [];
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "скажи раз" },
  ];
  const saved: ChatMessage[] = [];
  const events: AgentLoopEvent[] = [];

  const result = await runAgent({
    llm,
    model: "burmalda-mock",
    tools: registryWithEcho(log),
    messages,
    ctx: ctx(),
    onMessage: (m) => {
      saved.push(m);
    },
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.finalText, "Готово");
  assert.equal(result.steps, 2);
  assert.equal(result.stoppedBy, "answer");
  assert.deepEqual(log, ["раз"]);
  assert.equal(result.usage.promptTokens, 250);
  assert.equal(result.usage.completionTokens, 15);

  // assistant(tool_calls) → tool → assistant
  assert.deepEqual(
    messages.slice(2).map((m) => m.role),
    ["assistant", "tool", "assistant"],
  );
  const toolMessage = messages[3] as Extract<ChatMessage, { role: "tool" }>;
  assert.equal(toolMessage.content, "эхо: раз");
  const call = (messages[2] as Extract<ChatMessage, { role: "assistant" }>)
    .tool_calls![0]!;
  assert.equal(toolMessage.tool_call_id, call.id);
  assert.equal(saved.length, 3);

  // В запрос к модели уходят спецификации инструментов
  assert.equal(llm.requests[0]!.tools?.[0]?.function.name, "echo");
  assert.equal(llm.requests[0]!.user, "s1");
  assert.ok(events.some((e) => e.type === "tool_result" && e.ok));
});

test("цикл: неизвестный инструмент и битый JSON возвращаются модели как ошибка, цикл продолжается", async () => {
  const llm = new FakeLlmClient([
    { toolCalls: [{ name: "nope", args: {} }] },
    { toolCalls: [{ name: "echo", args: {} }] },
    { text: "Понял" },
  ]);
  const messages: ChatMessage[] = [{ role: "user", content: "x" }];
  const result = await runAgent({
    llm,
    model: "m",
    tools: registryWithEcho(),
    messages,
    ctx: ctx(),
  });
  assert.equal(result.finalText, "Понял");
  const toolResults = messages
    .filter((m) => m.role === "tool")
    .map((m) => m.content);
  assert.match(toolResults[0]!, /неизвестный инструмент nope/);
  assert.match(toolResults[1]!, /не хватает обязательных параметров: text/);
});

test("цикл: опасный инструмент без подтверждения не выполняется", async () => {
  const registry = new ToolRegistry();
  let ran = false;
  registry.register({
    name: "rm",
    description: "Удалить",
    parameters: { type: "object", properties: {} },
    dangerous: true,
    execute: async () => {
      ran = true;
      return "удалено";
    },
  });
  const llm = new FakeLlmClient([
    { toolCalls: [{ name: "rm", args: {} }] },
    { text: "Не стал" },
  ]);
  const messages: ChatMessage[] = [{ role: "user", content: "удали" }];
  await runAgent({
    llm,
    model: "m",
    tools: registry,
    messages,
    ctx: ctx(false),
  });
  assert.equal(ran, false);
  assert.equal(
    messages.find((m) => m.role === "tool")?.content,
    "Владелец отклонил действие",
  );
});

test("цикл: останавливается на лимите шагов", async () => {
  const turns = Array.from({ length: 3 }, () => ({
    toolCalls: [{ name: "echo", args: { text: "a" } }],
  }));
  const llm = new FakeLlmClient(turns);
  const result = await runAgent({
    llm,
    model: "m",
    tools: registryWithEcho(),
    messages: [{ role: "user", content: "x" }],
    ctx: ctx(),
    maxSteps: 3,
  });
  assert.equal(result.stoppedBy, "max_steps");
  assert.equal(result.steps, 3);
});

test("цикл: beforeStep получает точный размер контекста прошлого шага", async () => {
  const llm = new FakeLlmClient([
    {
      toolCalls: [{ name: "echo", args: { text: "a" } }],
      usage: { prompt_tokens: 777 },
    },
    { text: "ok" },
  ]);
  const seen: Array<number | undefined> = [];
  await runAgent({
    llm,
    model: "m",
    tools: registryWithEcho(),
    messages: [{ role: "user", content: "x" }],
    ctx: ctx(),
    beforeStep: async (_m, info) => {
      seen.push(info.lastPromptTokens);
    },
  });
  assert.deepEqual(seen, [undefined, 777]);
});

test("цикл: строит дерево спанов agent → llm/tool", async () => {
  const spans: Array<{ name: string; kind: string; parent?: string }> = [];
  const tracer: Tracer = {
    startSpan(name, kind, _attrs, parent) {
      const span: Span & { name: string } = {
        name,
        setAttributes: () => undefined,
        recordError: () => undefined,
        end: () => undefined,
      };
      spans.push({
        name,
        kind,
        parent: (parent as { name?: string } | undefined)?.name,
      });
      return span;
    },
  };
  const llm = new FakeLlmClient([
    { toolCalls: [{ name: "echo", args: { text: "a" } }] },
    { text: "ok" },
  ]);
  await runAgent({
    llm,
    model: "m",
    tools: registryWithEcho(),
    messages: [{ role: "user", content: "x" }],
    ctx: ctx(),
    tracer,
  });
  assert.deepEqual(spans, [
    { name: "agent.run", kind: "AGENT", parent: undefined },
    { name: "llm.chat", kind: "LLM", parent: "agent.run" },
    { name: "tool.echo", kind: "TOOL", parent: "agent.run" },
    { name: "llm.chat", kind: "LLM", parent: "agent.run" },
  ]);
});
