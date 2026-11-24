/**
 * Заглушка для ещё не реализованных частей каркаса.
 * Ищи по `notImplemented(` — это список оставшихся задач.
 */
export function notImplemented(what: string): never {
  throw new Error(`[бурмалда] не реализовано: ${what}`);
}
