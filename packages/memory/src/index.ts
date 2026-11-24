import { notImplemented } from "@burmalda/shared";
import pg from "pg";

/**
 * Память «бурмалды» (Postgres + pgvector):
 * - краткосрочная: сообщения сессии и саммари после compaction (общие для всех каналов);
 * - долговременная: факты о владельце с эмбеддингами (burmalda-embed через шлюз)
 *   + полнотекстовый поиск + явный профиль ключ-значение. Поиск гибридный, не только векторный.
 */

export interface StoredMessage {
  sessionId: string;
  role: "system" | "user" | "assistant" | "tool";
  /** Полное сообщение ядра в JSON (включая tool_calls). */
  payload: unknown;
  channel: string;
  createdAt: Date;
}

export interface MemoryFact {
  id: string;
  text: string;
  tags: string[];
  score?: number;
}

export interface ShortTermMemory {
  append(message: StoredMessage): Promise<void>;
  load(sessionId: string): Promise<StoredMessage[]>;
  replaceWithSummary(
    sessionId: string,
    summary: string,
    keepFromId: string,
  ): Promise<void>;
}

export interface LongTermMemory {
  remember(text: string, tags?: string[]): Promise<MemoryFact>;
  /** Гибрид: косинус pgvector + ts_rank, слияние через RRF. */
  recall(query: string, limit?: number): Promise<MemoryFact[]>;
  forget(id: string): Promise<void>;
}

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** TODO(A): миграции (sessions, messages, facts с vector(1024) под bge-m3) и реализации. */
export function createMemory(_pool: pg.Pool): {
  shortTerm: ShortTermMemory;
  longTerm: LongTermMemory;
} {
  return notImplemented("память");
}
