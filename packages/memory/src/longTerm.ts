import type pg from "pg";
import type { EmbeddingClient } from "@burmalda/core";
import { rrfFuse, toPgVector } from "./rrf";

export interface MemoryFact {
  id: string;
  text: string;
  tags: string[];
  createdAt: string;
  score?: number;
}

export interface LongTermMemoryOptions {
  embedder: EmbeddingClient;
  embedModel: string;
  /** Косинусное расстояние, ниже которого новый факт считается дублем и обновляет старый. */
  duplicateDistance?: number;
  onEmbeddingError?: (error: unknown) => void;
}

interface FactRow {
  id: string;
  text: string;
  tags: string[];
  created_at: Date;
}

/**
 * Долговременная память владельца: факты с эмбеддингами (pgvector) + полнотекст + триграммы.
 * recall объединяет три списка через RRF. Если шлюз эмбеддингов недоступен — работает без вектора.
 */
export class LongTermMemory {
  constructor(
    private readonly pool: pg.Pool,
    private readonly options: LongTermMemoryOptions,
  ) {}

  async remember(
    ownerId: string,
    text: string,
    tags: string[] = [],
    source = "tool",
  ): Promise<{ fact: MemoryFact; updated: boolean }> {
    const clean = text.trim();
    if (!clean) throw new Error("Пустой факт");
    const embedding = await this.embedSafe(clean);

    if (embedding) {
      const duplicate = await this.pool.query<FactRow & { distance: number }>(
        `SELECT id, text, tags, created_at, embedding <=> $2::vector AS distance
         FROM facts WHERE owner_id = $1 AND embedding IS NOT NULL
         ORDER BY embedding <=> $2::vector LIMIT 1`,
        [ownerId, toPgVector(embedding)],
      );
      const nearest = duplicate.rows[0];
      if (
        nearest &&
        nearest.distance < (this.options.duplicateDistance ?? 0.08)
      ) {
        const updated = await this.pool.query<FactRow>(
          `UPDATE facts SET text = $2, tags = (SELECT array(SELECT DISTINCT unnest(tags || $3::text[]))),
             embedding = $4::vector, updated_at = now()
           WHERE id = $1 RETURNING id, text, tags, created_at`,
          [nearest.id, clean, tags, toPgVector(embedding)],
        );
        return { fact: toFact(updated.rows[0]!), updated: true };
      }
    }

    const inserted = await this.pool.query<FactRow>(
      `INSERT INTO facts (owner_id, text, tags, source, embedding)
       VALUES ($1, $2, $3, $4, $5::vector) RETURNING id, text, tags, created_at`,
      [ownerId, clean, tags, source, embedding ? toPgVector(embedding) : null],
    );
    return { fact: toFact(inserted.rows[0]!), updated: false };
  }

  async recall(
    ownerId: string,
    query: string,
    limit = 5,
  ): Promise<MemoryFact[]> {
    const clean = query.trim();
    if (!clean) return [];
    const candidates = Math.max(limit * 4, 20);
    const embedding = await this.embedSafe(clean);

    const [vector, fulltext, trigram] = await Promise.all([
      embedding
        ? this.pool.query<FactRow>(
            `SELECT id, text, tags, created_at FROM facts
             WHERE owner_id = $1 AND embedding IS NOT NULL
             ORDER BY embedding <=> $2::vector LIMIT $3`,
            [ownerId, toPgVector(embedding), candidates],
          )
        : Promise.resolve({ rows: [] as FactRow[] }),
      this.pool.query<FactRow>(
        `SELECT id, text, tags, created_at FROM facts
         WHERE owner_id = $1 AND tsv @@ (websearch_to_tsquery('russian', $2) || websearch_to_tsquery('english', $2))
         ORDER BY ts_rank(tsv, websearch_to_tsquery('russian', $2) || websearch_to_tsquery('english', $2)) DESC
         LIMIT $3`,
        [ownerId, clean, candidates],
      ),
      this.pool.query<FactRow>(
        `SELECT id, text, tags, created_at FROM facts
         WHERE owner_id = $1 AND word_similarity($2, text) > 0.3
         ORDER BY word_similarity($2, text) DESC LIMIT $3`,
        [ownerId, clean, candidates],
      ),
    ]);

    const fused = rrfFuse([
      vector.rows.map(toFact),
      fulltext.rows.map(toFact),
      trigram.rows.map(toFact),
    ]).slice(0, limit);

    if (fused.length > 0) {
      await this.pool.query(
        `UPDATE facts SET use_count = use_count + 1, last_used_at = now() WHERE id = ANY($1::uuid[])`,
        [fused.map((fact) => fact.id)],
      );
    }
    return fused;
  }

  async list(ownerId: string, limit = 50): Promise<MemoryFact[]> {
    const rows = await this.pool.query<FactRow>(
      `SELECT id, text, tags, created_at FROM facts WHERE owner_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [ownerId, limit],
    );
    return rows.rows.map(toFact);
  }

  async forget(ownerId: string, id: string): Promise<boolean> {
    const result = await this.pool.query(
      `DELETE FROM facts WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return (result.rowCount ?? 0) > 0;
  }

  private async embedSafe(text: string): Promise<number[] | null> {
    try {
      const [vector] = await this.options.embedder.embed(
        [text],
        this.options.embedModel,
      );
      return vector ?? null;
    } catch (error) {
      this.options.onEmbeddingError?.(error);
      return null;
    }
  }
}

function toFact(row: FactRow): MemoryFact {
  return {
    id: row.id,
    text: row.text,
    tags: row.tags,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
