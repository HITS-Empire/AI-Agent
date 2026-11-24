import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ContextManager,
  SUMMARY_PREFIX,
  contextTokens,
  estimateTokens,
  renderTranscript,
} from "./compaction";
import { FakeLlmClient } from "../llm/fakeClient";
import type { ChatMessage } from "../llm/types";

function conversation(turns: number, toolOutput = "результат"): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: "Ты — бурмалда." },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: "user", content: `вопрос ${i} ${"x".repeat(300)}` });
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: `c${i}`,
          type: "function",
          function: { name: "echo", arguments: "{}" },
        },
      ],
    });
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: toolOutput });
    messages.push({ role: "assistant", content: `ответ ${i}` });
  }
  return messages;
}

test("contextTokens: точное число прошлого запроса + оценка только новых сообщений", () => {
  const messages = conversation(2);
  const base = contextTokens(messages, {
    step: 2,
    lastPromptTokens: 5000,
    messagesAtLastRequest: 7,
  });
  assert.equal(base, 5000 + estimateTokens(messages.slice(7)));
  assert.equal(contextTokens(messages), estimateTokens(messages));
});

test("ниже порога — ничего не делает и не зовёт модель", async () => {
  const llm = new FakeLlmClient([]);
  const manager = new ContextManager({
    llm,
    model: "fast",
    contextWindow: 100_000,
    compactAt: 0.7,
  });
  const messages = conversation(2);
  assert.equal(await manager.maybeCompact(messages), null);
  assert.equal(llm.requests.length, 0);
});

test("сначала урезает длинные выводы инструментов, если этого достаточно — без саммари", async () => {
  const llm = new FakeLlmClient([]);
  const messages = conversation(6, "y".repeat(20_000));
  const before = estimateTokens(messages);
  const manager = new ContextManager({
    llm,
    model: "fast",
    contextWindow: Math.ceil(before / 0.7) - 10,
    compactAt: 0.7,
    keepRecent: 4,
  });
  const result = await manager.maybeCompact(messages);
  assert.equal(result?.kind, "pruned");
  assert.equal(llm.requests.length, 0);
  // последний вывод инструмента в хвосте не тронут
  assert.equal((messages.at(-2) as { content: string }).content.length, 20_000);
  assert.ok(result!.tokensAfter < before);
});

test("саммаризация: старая часть заменена сводкой, system и хвост с целыми tool-парами сохранены", async () => {
  const llm = new FakeLlmClient([{ text: "- владелец спрашивал вопросы 0–7" }]);
  const messages = conversation(10);
  const manager = new ContextManager({
    llm,
    model: "burmalda-fast",
    contextWindow: 1000,
    compactAt: 0.5,
    keepRecent: 6,
  });
  const result = await manager.maybeCompact(messages);

  assert.equal(result?.kind, "summarized");
  assert.equal(messages[0]!.content, "Ты — бурмалда.");
  assert.equal(messages[1]!.role, "system");
  assert.ok(messages[1]!.content!.startsWith(SUMMARY_PREFIX));
  // хвост начинается с user и не содержит «осиротевших» tool
  assert.equal(messages[2]!.role, "user");
  const callIds = new Set(
    messages.flatMap((m) =>
      m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.id) : [],
    ),
  );
  for (const m of messages)
    if (m.role === "tool") assert.ok(callIds.has(m.tool_call_id));
  assert.equal(result!.keptMessages, messages.length - 2);
  assert.equal(result!.removedMessages + result!.keptMessages, 40);

  // в модель ушла дешёвая модель и расшифровка без tool-разметки API
  assert.equal(llm.requests[0]!.model, "burmalda-fast");
  assert.match(
    llm.requests[0]!.messages[1]!.content as string,
    /\[владелец\] вопрос 0/,
  );
  assert.equal(llm.requests[0]!.tools, undefined);
});

test("повторная компакция сворачивает и прошлую сводку", async () => {
  const llm = new FakeLlmClient([{ text: "сводка 1" }, { text: "сводка 2" }]);
  const manager = new ContextManager({
    llm,
    model: "f",
    contextWindow: 1000,
    compactAt: 0.5,
    keepRecent: 4,
  });
  const messages = conversation(8);
  await manager.maybeCompact(messages);
  messages.push(...conversation(8).slice(1));
  await manager.maybeCompact(messages);
  const summaries = messages.filter(
    (m) => m.role === "system" && m.content.startsWith(SUMMARY_PREFIX),
  );
  assert.equal(summaries.length, 1);
  assert.match(String(summaries[0]!.content), /сводка 2/);
  assert.match(llm.requests[1]!.messages[1]!.content as string, /сводка 1/);
});

test("findCut: если резать нечего — null", () => {
  const manager = new ContextManager({
    llm: new FakeLlmClient([]),
    model: "f",
    contextWindow: 10,
    compactAt: 0.1,
  });
  assert.equal(
    manager.findCut([
      { role: "system", content: "s" },
      { role: "user", content: "u" },
    ]),
    null,
  );
});

test("renderTranscript урезает длинные результаты", () => {
  const text = renderTranscript(
    [{ role: "tool", tool_call_id: "1", content: "z".repeat(5000) }],
    100,
  );
  assert.ok(text.length < 200);
});

test("оценка учитывает невидимую часть запроса, пока нет точной цифры", () => {
  const messages = [{ role: "user" as const, content: "x".repeat(300) }];
  const base = contextTokens(messages);
  assert.equal(contextTokens(messages, undefined, 1700), base + 1700);
  // с точной цифрой от шлюза надбавка не нужна — она уже внутри prompt_tokens
  assert.equal(
    contextTokens(
      messages,
      { step: 2, lastPromptTokens: 5000, messagesAtLastRequest: 1 },
      1700,
    ),
    5000,
  );
});
