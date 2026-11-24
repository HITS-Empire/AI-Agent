/**
 * Заглушка для ещё не реализованных частей ядра (своя копия, чтобы у ядра не было зависимостей).
 */
export function notImplemented(what: string): never {
  throw new Error(`[бурмалда] не реализовано: ${what}`);
}
