import type pg from "pg";

/** Явный профиль владельца: точные значения без поиска (имя, город, предпочтения). */
export class ProfileStore {
  constructor(private readonly pool: pg.Pool) {}

  async set(ownerId: string, key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO profile (owner_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (owner_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [ownerId, key.trim().toLowerCase(), value.trim()],
    );
  }

  async delete(ownerId: string, key: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM profile WHERE owner_id = $1 AND key = $2`,
      [ownerId, key.trim().toLowerCase()],
    );
  }

  async all(ownerId: string): Promise<Record<string, string>> {
    const rows = await this.pool.query<{ key: string; value: string }>(
      `SELECT key, value FROM profile WHERE owner_id = $1 ORDER BY key`,
      [ownerId],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.key, row.value]));
  }
}
