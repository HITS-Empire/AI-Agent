import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { FakeEmbeddingClient, type ChatMessage } from "@burmalda/core";
import {
  LongTermMemory,
  ProfileStore,
  ShortTermMemory,
  UsageStore,
  createPool,
  migrate,
} from "./index";

/**
 * Интеграционные тесты на настоящем Postgres + pgvector. Запуск:
 * TEST_DATABASE_URL=postgresql://burmalda:burmalda@127.0.0.1:5432/burmalda pnpm test
 */
const url = process.env.TEST_DATABASE_URL;

describe(
  "память на Postgres",
  { skip: !url && "TEST_DATABASE_URL не задан" },
  () => {
    const pool = url ? createPool(url) : undefined!;
    const owner = `test-${randomUUID()}`;
    const session = `${owner}:main`;
    const embedder = new FakeEmbeddingClient(1024);

    before(async () => {
      await migrate(pool, 1024);
    });

    after(async () => {
      await pool.query(`DELETE FROM facts WHERE owner_id = $1`, [owner]);
      await pool.query(`DELETE FROM profile WHERE owner_id = $1`, [owner]);
      await pool.query(`DELETE FROM sessions WHERE owner_id = $1`, [owner]);
      await pool.query(`DELETE FROM usage_log WHERE session_id = $1`, [
        session,
      ]);
      await pool.end();
    });

    test("краткосрочная: сессия общая для каналов, compaction помечает старое и сохраняет сводку", async () => {
      const memory = new ShortTermMemory(pool);
      await memory.ensureSession(session, owner);
      const messages: ChatMessage[] = [
        { role: "user", content: "начал в телеграме" },
        { role: "assistant", content: "ок" },
        { role: "user", content: "продолжил в cli" },
        { role: "assistant", content: "вижу" },
      ];
      await memory.append(session, "telegram", messages[0]!);
      await memory.append(session, "telegram", messages[1]!);
      await memory.append(session, "cli", messages[2]!);
      await memory.append(session, "cli", messages[3]!);
      assert.deepEqual(await memory.load(session), messages);

      const compacted = await memory.compact(
        session,
        "владелец писал из двух каналов",
        2,
      );
      assert.equal(compacted, 2);
      const loaded = await memory.load(session);
      assert.equal(loaded.length, 3);
      assert.equal(loaded[0]!.role, "system");
      assert.match(
        loaded[0]!.content as string,
        /владелец писал из двух каналов/,
      );
      assert.deepEqual(loaded.slice(1), messages.slice(2));
    });

    test("долговременная: вектор + полнотекст, дедупликация, forget", async () => {
      const memory = new LongTermMemory(pool, { embedder, embedModel: "fake" });
      await memory.remember(owner, "Владелец пьёт кофе без сахара", ["еда"]);
      await memory.remember(owner, "Владелец учится в группе 972302 в ТГУ", [
        "учёба",
      ]);
      await memory.remember(owner, "У владельца есть кот Барсик");

      const dup = await memory.remember(
        owner,
        "Владелец пьёт кофе без сахара",
        ["привычки"],
      );
      assert.equal(dup.updated, true);
      assert.equal((await memory.list(owner)).length, 3);

      const coffee = await memory.recall(owner, "какой кофе пьёт владелец", 2);
      assert.match(coffee[0]!.text, /кофе/);

      // полнотекст с морфологией: «группа» → «группе»
      const group = await memory.recall(owner, "группа", 1);
      assert.match(group[0]!.text, /972302/);

      assert.equal(await memory.forget(owner, coffee[0]!.id), true);
      assert.equal((await memory.list(owner)).length, 2);
    });

    test("долговременная: без эмбеддингов работает полнотекст и триграммы", async () => {
      const memory = new LongTermMemory(pool, {
        embedder: {
          embed: async () => Promise.reject(new Error("шлюз недоступен")),
        },
        embedModel: "x",
      });
      await memory.remember(
        owner,
        "Любимый маркетплейс владельца — Яндекс Маркет",
      );
      const found = await memory.recall(owner, "маркетплейс", 3);
      assert.ok(found.some((f) => f.text.includes("Яндекс Маркет")));
    });

    test("профиль и журнал расхода", async () => {
      const profile = new ProfileStore(pool);
      await profile.set(owner, "City", "Томск");
      assert.deepEqual(await profile.all(owner), { city: "Томск" });

      const usage = new UsageStore(pool);
      await usage.record({ sessionId: session, taskId: "t", channel: "cli" }, [
        [
          "burmalda-main",
          {
            calls: 2,
            promptTokens: 100,
            completionTokens: 20,
            cachedTokens: 0,
            costUsd: 0.001,
          },
        ],
      ]);
      const rows = await usage.daily(1);
      assert.ok(
        rows.some((r) => r.model === "burmalda-main" && r.promptTokens >= 100),
      );
    });
  },
);
