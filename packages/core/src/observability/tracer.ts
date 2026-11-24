/**
 * Минимальный интерфейс трассировки для ядра. Реализация на OpenTelemetry живёт в harness
 * (`@burmalda/observability`), ядро от библиотек не зависит. Атрибуты — в духе OpenInference,
 * чтобы Phoenix показывал спаны агента, LLM и инструментов.
 */
export type SpanKind =
  "AGENT" | "CHAIN" | "LLM" | "TOOL" | "EMBEDDING" | "RETRIEVER";
export type AttributeValue = string | number | boolean | string[];
export type Attributes = Record<string, AttributeValue | undefined>;

export interface Span {
  /** id трейса (OpenTelemetry), чтобы связать логи с трейсами; у noop-спана нет. */
  readonly traceId?: string;
  setAttributes(attributes: Attributes): void;
  recordError(error: unknown): void;
  end(): void;
}

export interface Tracer {
  startSpan(
    name: string,
    kind: SpanKind,
    attributes?: Attributes,
    parent?: Span,
  ): Span;
}

const noopSpan: Span = {
  setAttributes: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

export const noopTracer: Tracer = {
  startSpan: () => noopSpan,
};

/** Обрезка длинных значений для атрибутов спанов. */
export function previewValue(value: unknown, max = 4000): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
