import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  ContextManager,
  FakeLlmClient,
  ToolRegistry,
  runAgent,
  type ChatMessage,
} from "@burmalda/core";
import { createTracing } from "./index";

test("спаны агента уходят в OTel с атрибутами OpenInference и иерархией", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({
    serviceName: "test",
    exporter,
    simple: true,
  });
  const tools = new ToolRegistry();
  tools.register({
    name: "ping",
    description: "ping",
    parameters: { type: "object", properties: {} },
    execute: async () => "pong",
  });

  await runAgent({
    llm: new FakeLlmClient([
      {
        toolCalls: [{ name: "ping", args: {} }],
        usage: { prompt_tokens: 40, completion_tokens: 2 },
      },
      { text: "готово", usage: { prompt_tokens: 50, completion_tokens: 3 } },
    ]),
    model: "burmalda-mock",
    tools,
    messages: [{ role: "user", content: "пингани" }],
    ctx: {
      sessionId: "owner:main",
      taskId: "t1",
      workspaceRoot: "/",
      requestApproval: async () => true,
    },
    tracer: tracing.tracer,
  });
  // InMemorySpanExporter очищается при shutdown — читаем до него
  const spans = exporter.getFinishedSpans();
  await tracing.shutdown();
  const agent = spans.find((s) => s.name === "agent.run")!;
  const llm = spans.filter((s) => s.name === "llm.chat");
  const tool = spans.find((s) => s.name === "tool.ping")!;

  assert.equal(agent.attributes["openinference.span.kind"], "AGENT");
  assert.equal(agent.attributes["session.id"], "owner:main");
  assert.equal(agent.attributes["llm.token_count.total"], 95);
  assert.equal(llm.length, 2);
  assert.equal(llm[0]!.attributes["llm.token_count.prompt"], 40);
  assert.equal(tool.attributes["output.value"], "pong");
  for (const child of [...llm, tool]) {
    assert.equal(child.parentSpanContext?.spanId, agent.spanContext().spanId);
    assert.equal(child.spanContext().traceId, agent.spanContext().traceId);
  }
  assert.equal(
    agent.resource.attributes["openinference.project.name"],
    "burmalda",
  );
});

test("сводка при compaction — отдельный спан llm.chat под context.compaction", async () => {
  const exporter = new InMemorySpanExporter();
  const tracing = createTracing({
    serviceName: "test",
    exporter,
    simple: true,
  });
  const context = new ContextManager({
    llm: new FakeLlmClient([{ text: "- сводка" }]),
    model: "burmalda-fast",
    contextWindow: 100,
    compactAt: 0.5,
    keepRecent: 1,
    tracer: tracing.tracer,
  });
  const long = "x".repeat(300);
  const messages: ChatMessage[] = [
    { role: "system", content: "s" },
    { role: "user", content: long },
    { role: "assistant", content: long },
    { role: "user", content: "ещё" },
  ];
  const result = await context.maybeCompact(messages);
  assert.equal(result?.kind, "summarized");
  const spans = exporter.getFinishedSpans();
  const compaction = spans.find((s) => s.name === "context.compaction")!;
  const llm = spans.find((s) => s.name === "llm.chat")!;
  assert.equal(llm.parentSpanContext?.spanId, compaction.spanContext().spanId);
  assert.equal(llm.attributes["llm.model_name"], "burmalda-fast");
  assert.equal(llm.attributes["burmalda.purpose"], "compaction");
  await tracing.shutdown();
});
