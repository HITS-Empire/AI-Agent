import { test } from "node:test";
import assert from "node:assert/strict";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { FakeLlmClient, ToolRegistry, runAgent } from "@burmalda/core";
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
