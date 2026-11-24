import type pg from "pg";

/**
 * Схема памяти. Идемпотентно: можно выполнять при каждом старте.
 * Размерность вектора — под модель эмбеддингов (bge-m3 = 1024).
 */
export function schemaSql(dimensions: number): string {
  return `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Краткосрочная память: сообщения сессии в формате ядра. compacted = свернуто в сводку.
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  channel text NOT NULL,
  role text NOT NULL,
  payload jsonb NOT NULL,
  compacted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_session_active_idx ON messages (session_id, id) WHERE NOT compacted;

CREATE TABLE IF NOT EXISTS summaries (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  content text NOT NULL,
  messages_compacted int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Долговременная память: факты о владельце. Поиск гибридный: вектор + полнотекст + триграммы.
CREATE TABLE IF NOT EXISTS facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  text text NOT NULL,
  tags text[] NOT NULL DEFAULT '{}',
  source text NOT NULL DEFAULT 'tool',
  embedding vector(${dimensions}),
  tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('russian', text) || to_tsvector('english', text)
  ) STORED,
  use_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS facts_owner_idx ON facts (owner_id);
CREATE INDEX IF NOT EXISTS facts_embedding_idx ON facts USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS facts_tsv_idx ON facts USING gin (tsv);
CREATE INDEX IF NOT EXISTS facts_trgm_idx ON facts USING gin (text gin_trgm_ops);

-- Явный профиль владельца: ключ-значение (имя, город, часовой пояс, предпочтения).
CREATE TABLE IF NOT EXISTS profile (
  owner_id text NOT NULL,
  key text NOT NULL,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, key)
);

-- Локальный учёт расхода по задачам (источник правды — spend logs LiteLLM).
CREATE TABLE IF NOT EXISTS usage_log (
  id bigserial PRIMARY KEY,
  session_id text NOT NULL,
  task_id text NOT NULL,
  channel text NOT NULL,
  model text NOT NULL,
  calls int NOT NULL,
  prompt_tokens int NOT NULL,
  completion_tokens int NOT NULL,
  cached_tokens int NOT NULL DEFAULT 0,
  cost_usd double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_log_created_idx ON usage_log (created_at);
`;
}

export async function migrate(
  pool: pg.Pool,
  dimensions: number,
): Promise<void> {
  await pool.query(schemaSql(dimensions));
}
