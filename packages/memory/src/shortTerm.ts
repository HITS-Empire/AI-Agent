import type pg from "pg";
import { SUMMARY_PREFIX, type ChatMessage } from "@burmalda/core";

/**
 * Краткосрочная память: история сессии. Сессия принадлежит владельцу, а не каналу,
 * поэтому разговор из Telegram продолжается в CLI.
 */
export class ShortTermMemory {
  constructor(private readonly pool: pg.Pool) {}

  async ensureSession(sessionId: string, ownerId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO sessions (id, owner_id) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [sessionId, ownerId],
    );
  }

  async append(
    sessionId: string,
    channel: string,
    message: ChatMessage,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (session_id, channel, role, payload) VALUES ($1, $2, $3, $4)`,
      [sessionId, channel, message.role, JSON.stringify(message)],
    );
  }

  /** Активная история: последняя сводка (как system) + несвёрнутые сообщения по порядку. */
  async load(sessionId: string): Promise<ChatMessage[]> {
    const [summary, rows] = await Promise.all([
      this.pool.query<{ content: string }>(
        `SELECT content FROM summaries WHERE session_id = $1 ORDER BY id DESC LIMIT 1`,
        [sessionId],
      ),
      this.pool.query<{ payload: ChatMessage }>(
        `SELECT payload FROM messages WHERE session_id = $1 AND NOT compacted ORDER BY id`,
        [sessionId],
      ),
    ]);
    const history = sanitizeHistory(rows.rows.map((row) => row.payload));
    const latest = summary.rows[0];
    return latest
      ? [
          { role: "system", content: `${SUMMARY_PREFIX}\n${latest.content}` },
          ...history,
        ]
      : history;
  }

  /**
   * Отразить compaction: все активные сообщения, кроме последних keptMessages, помечаются свёрнутыми,
   * сводка сохраняется. Сообщения пишутся в БД сразу, поэтому порядок в памяти и в БД совпадает.
   */
  async compact(
    sessionId: string,
    summary: string,
    keptMessages: number,
  ): Promise<number> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE messages SET compacted = true
         WHERE session_id = $1 AND NOT compacted AND id NOT IN (
           SELECT id FROM messages WHERE session_id = $1 AND NOT compacted ORDER BY id DESC LIMIT $2
         )`,
        [sessionId, keptMessages],
      );
      await client.query(
        `INSERT INTO summaries (session_id, content, messages_compacted) VALUES ($1, $2, $3)`,
        [sessionId, summary, result.rowCount ?? 0],
      );
      await client.query("COMMIT");
      return result.rowCount ?? 0;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async clear(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE messages SET compacted = true WHERE session_id = $1`,
      [sessionId],
    );
    await this.pool.query(`DELETE FROM summaries WHERE session_id = $1`, [
      sessionId,
    ]);
  }
}

/**
 * Защита от «битой» истории (например, процесс упал между tool_call и tool):
 * убираем tool без вызова и вызовы без ответа — иначе провайдер отклонит запрос.
 */
export function sanitizeHistory(messages: ChatMessage[]): ChatMessage[] {
  const answered = new Set(
    messages
      .filter((m) => m.role === "tool")
      .map((m) => (m as { tool_call_id: string }).tool_call_id),
  );
  const called = new Set<string>();
  const result: ChatMessage[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.tool_calls?.length) {
      const calls = message.tool_calls.filter((call) => answered.has(call.id));
      calls.forEach((call) => called.add(call.id));
      if (calls.length === 0) {
        if (message.content)
          result.push({ role: "assistant", content: message.content });
        continue;
      }
      result.push({ ...message, tool_calls: calls });
    } else if (message.role === "tool") {
      if (called.has(message.tool_call_id)) result.push(message);
    } else {
      result.push(message);
    }
  }
  return result;
}
