import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FakeLlmClient,
  SUMMARY_PREFIX,
  ToolRegistry,
  type ChatMessage,
  type ModelUsage,
} from "@burmalda/core";
import type { AgentEvent } from "@burmalda/shared";
import {
  AgentRuntime,
  InMemorySessionStore,
  type RuntimeDeps,
} from "./runtime";
import { buildSystemPrompt } from "./prompt";

class FakeFacts {
  readonly saved: Array<{ text: string; source?: string }> = [];
  async recall(_owner: string, query: string) {
    return this.saved.filter(
      (f) => query.toLowerCase().includes("кофе") && f.text.includes("кофе"),
    );
  }
  async remember(
    _owner: string,
    text: string,
    _tags?: string[],
    source?: string,
  ) {
    this.saved.push({ text, ...(source ? { source } : {}) });
    return {};
  }
}

function setup(llm: FakeLlmClient, extra: Partial<RuntimeDeps> = {}) {
  const sessions = new InMemorySessionStore();
  const facts = new FakeFacts();
  const usage: Array<Array<[string, ModelUsage]>> = [];
  const tools = new ToolRegistry();
  tools.register<{ text: string }>({
    name: "remember",
    description: "запомнить",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
    execute: async (args) => {
      await facts.remember("owner", args.text, [], "tool");
      return "Запомнил";
    },
  });
  const runtime = new AgentRuntime({
    llm,
    models: { main: "burmalda-mock", fast: "burmalda-mock" },
    tools,
    sessions,
    facts,
    profile: { all: async () => ({ имя: "Саша" }) },
    usageStore: { record: async (_e, byModel) => void usage.push(byModel) },
    context: { window: 100_000, compactAt: 0.7 },
    instructions: async () => {
      throw new Error("не реализовано: чтение AGENTS.md");
    },
    now: () => new Date("2026-11-24T05:00:00Z"),
    ...extra,
  });
  return { runtime, sessions, facts, usage };
}

const task = (text: string, channel: "cli" | "telegram" = "cli") => ({
  text,
  sessionId: "owner:main",
  ownerId: "owner",
  channel,
});

test("задача: инструмент, ответ, события, сохранение истории и расхода", async () => {
  const llm = new FakeLlmClient([
    {
      toolCalls: [
        { name: "remember", args: { text: "Владелец пьёт кофе без сахара" } },
      ],
    },
    {
      text: "Запомнил: кофе без сахара.",
      usage: { prompt_tokens: 120, completion_tokens: 8 },
    },
  ]);
  const { runtime, sessions, facts, usage } = setup(llm);
  const events: AgentEvent[] = [];

  const result = await runtime.run(task("Запомни: я пью кофе без сахара"), {
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.text, "Запомнил: кофе без сахара.");
  assert.deepEqual(
    events.map((e) => e.type),
    ["status", "tool_call", "tool_result", "message", "done"],
  );
  assert.equal(facts.saved[0]?.text, "Владелец пьёт кофе без сахара");
  const history = await sessions.load("owner:main");
  assert.deepEqual(
    history.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(usage.length, 1);
  assert.equal(result.usage.promptTokens, 130);

  // system prompt: дата в Asia/Tomsk, профиль; сбой AGENTS.md не уронил задачу
  const system = llm.requests[0]!.messages[0]!.content!;
  assert.match(system, /бурмалда/);
  assert.match(system, /12:00/);
  assert.match(system, /имя: Саша/);
});

test("сессия общая для каналов: CLI продолжает разговор из Telegram, факты вспоминаются", async () => {
  const llm = new FakeLlmClient([
    { text: "Привет!" },
    (request) => {
      const roles = request.messages.map((m) => m.role);
      assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
      assert.match(request.messages[0]!.content!, /кофе без сахара/);
      return { text: "Без сахара, как обычно." };
    },
  ]);
  const { runtime, facts } = setup(llm);
  facts.saved.push({ text: "Владелец пьёт кофе без сахара" });

  await runtime.run(task("Привет", "telegram"));
  const second = await runtime.run(task("Какой кофе мне сделать?", "cli"));
  assert.equal(second.text, "Без сахара, как обычно.");
});

test("compaction: старая часть заменяется сводкой и в памяти процесса, и в хранилище", async () => {
  const long = "x".repeat(900);
  let summaries = 0;
  const responder = (request: { messages: ChatMessage[] }) => {
    if (request.messages[0]!.content!.includes("сжимаешь историю")) {
      summaries++;
      return { text: `- сводка №${summaries}` };
    }
    return { text: `ответ ${long}` };
  };
  const llm = new FakeLlmClient(Array.from({ length: 20 }, () => responder));
  const { runtime, sessions } = setup(llm, {
    context: { window: 2000, compactAt: 0.7 },
  });

  const events: AgentEvent[] = [];
  const compactions = [];
  for (let i = 0; i < 5; i++) {
    const result = await runtime.run(task(`вопрос ${i} ${long}`), {
      onEvent: (e) => events.push(e),
    });
    compactions.push(...result.compactions);
  }

  assert.ok(summaries >= 1);
  assert.ok(compactions.some((c) => c.kind === "summarized"));
  assert.ok(
    events.some((e) => e.type === "status" && e.text.includes("контекст сжат")),
  );
  const history = await sessions.load("owner:main");
  assert.equal(history[0]!.role, "system");
  assert.equal(
    history[0]!.content,
    `${SUMMARY_PREFIX}\n- сводка №${summaries}`,
  );
  assert.equal(history.at(-2)!.content, `вопрос 4 ${long}`);
  // в запросах к основной модели после сжатия: system, сводка, короткий хвост — окно не переполнено
  const lastMain = llm.requests
    .filter((r) => !r.messages[0]!.content!.includes("сжимаешь"))
    .at(-1)!;
  assert.ok(lastMain.messages[1]!.content!.startsWith(SUMMARY_PREFIX));
  assert.ok(lastMain.messages.length <= 6);
});

test("задачи одной сессии выполняются по очереди", async () => {
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const slow: RuntimeDeps["llm"] = {
    async chat(request) {
      const text = String(request.messages.at(-1)!.content);
      order.push(`start ${text}`);
      if (text === "первая") await gate;
      order.push(`end ${text}`);
      return {
        id: "x",
        model: request.model,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "ok" },
          },
        ],
      };
    },
  };
  const { runtime } = setup(new FakeLlmClient([]), { llm: slow });
  const a = runtime.run(task("первая"));
  const b = runtime.run(task("вторая"));
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([a, b]);
  assert.deepEqual(order, [
    "start первая",
    "end первая",
    "start вторая",
    "end вторая",
  ]);
});

test("фоновое извлечение фактов сохраняет новые факты", async () => {
  const seen: ChatMessage[][] = [];
  const llm = new FakeLlmClient([
    { text: "Учту." },
    { text: "[]", usage: { prompt_tokens: 50, completion_tokens: 2 } },
  ]);
  const { runtime, facts, usage } = setup(llm, {
    extractFacts: async (messages, _known, _session, metered) => {
      seen.push(messages);
      await metered.chat({ model: "burmalda-fast", messages: [] });
      return ["Владелец учится в ТГУ"];
    },
  });
  const result = await runtime.run(task("Я учусь в ТГУ"));
  await result.background;
  // расход извлечения записан отдельной строкой журнала
  assert.equal(usage.length, 2);
  assert.equal(usage[1]![0]![0], "burmalda-fast");
  assert.deepEqual(
    seen[0]!.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.deepEqual(facts.saved, [
    { text: "Владелец учится в ТГУ", source: "extract" },
  ]);
});

test("ошибка модели — событие error и проброс", async () => {
  const { runtime } = setup(new FakeLlmClient([]));
  const events: AgentEvent[] = [];
  await assert.rejects(
    runtime.run(task("x"), { onEvent: (e) => events.push(e) }),
    /сценарий закончился/,
  );
  assert.equal(events.at(-1)?.type, "error");
});

test("system prompt: скиллы только метаданными, AGENTS.md целиком", () => {
  const prompt = buildSystemPrompt({
    now: new Date("2026-11-24T05:00:00Z"),
    agentsMd: [{ path: "AGENTS.md", content: "Пиши тесты." }],
    skills: [
      {
        name: "marketplace-search",
        description: "Поиск товаров",
        path: "/s/SKILL.md",
      },
    ],
  });
  assert.match(prompt, /Инструкции из AGENTS.md\nПиши тесты\./);
  assert.match(prompt, /- marketplace-search: Поиск товаров/);
  assert.doesNotMatch(prompt, /\/s\/SKILL.md/);
});
