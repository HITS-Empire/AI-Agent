import type pg from "pg";
import type { ModelUsage } from "@burmalda/core";

export interface UsageRow {
  day: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
}

/** Локальный журнал расхода по задачам — данные для /usage и дашборда. */
export class UsageStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(
    entry: { sessionId: string; taskId: string; channel: string },
    byModel: Array<[string, ModelUsage]>,
  ): Promise<void> {
    for (const [model, usage] of byModel) {
      await this.pool.query(
        `INSERT INTO usage_log (session_id, task_id, channel, model, calls, prompt_tokens, completion_tokens, cached_tokens, cost_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.sessionId,
          entry.taskId,
          entry.channel,
          model,
          usage.calls,
          usage.promptTokens,
          usage.completionTokens,
          usage.cachedTokens,
          usage.costUsd,
        ],
      );
    }
  }

  /** Расход по дням и моделям за последние N дней (по часовому поясу владельца). */
  async daily(days = 7, timeZone = "Asia/Tomsk"): Promise<UsageRow[]> {
    const rows = await this.pool.query<{
      day: string;
      model: string;
      calls: string;
      prompt_tokens: string;
      completion_tokens: string;
      cost_usd: number;
    }>(
      `SELECT to_char(date_trunc('day', created_at AT TIME ZONE $2), 'YYYY-MM-DD') AS day, model,
              sum(calls) AS calls, sum(prompt_tokens) AS prompt_tokens,
              sum(completion_tokens) AS completion_tokens, sum(cost_usd) AS cost_usd
       FROM usage_log WHERE created_at > now() - make_interval(days => $1)
       GROUP BY 1, 2 ORDER BY 1 DESC, 2`,
      [days, timeZone],
    );
    return rows.rows.map((row) => ({
      day: row.day,
      model: row.model,
      calls: Number(row.calls),
      promptTokens: Number(row.prompt_tokens),
      completionTokens: Number(row.completion_tokens),
      costUsd: Number(row.cost_usd),
    }));
  }
}
