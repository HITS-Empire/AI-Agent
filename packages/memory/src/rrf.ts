/**
 * Reciprocal Rank Fusion: объединяет несколько ранжированных списков в один.
 * score(d) = Σ 1 / (k + rank_i(d)). Не требует сопоставимых шкал (косинус vs ts_rank).
 */
export function rrfFuse<T extends { id: string }>(
  lists: T[][],
  k = 60,
): Array<T & { score: number }> {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const entry = scores.get(item.id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(item.id, entry);
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ item, score }) => ({ ...item, score }));
}

/** pgvector принимает вектор строкой '[0.1,0.2,…]'. */
export function toPgVector(vector: number[]): string {
  return `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
}
