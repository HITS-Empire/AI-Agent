import {
  context,
  trace,
  SpanStatusCode,
  type Span as OtelSpan,
} from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Attributes, Span, SpanKind, Tracer } from "@burmalda/core";

export interface TracingOptions {
  serviceName: string;
  /** Базовый адрес OTLP/HTTP (Phoenix: http://127.0.0.1:6006). */
  endpoint?: string;
  /** Проект в Phoenix (resource-атрибут openinference.project.name). */
  projectName?: string;
  /** Подмена экспортёра в тестах. */
  exporter?: SpanExporter;
  /** Синхронная отправка (тесты, короткие CLI-сессии). */
  simple?: boolean;
}

export interface Tracing {
  tracer: Tracer;
  shutdown(): Promise<void>;
}

/**
 * Трассировка на OpenTelemetry → OTLP/HTTP (protobuf) → Phoenix.
 * Атрибуты по OpenInference: Phoenix показывает дерево agent → llm/tool с токенами и вводом/выводом.
 */
export function createTracing(options: TracingOptions): Tracing {
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${(options.endpoint ?? "http://127.0.0.1:6006").replace(/\/$/, "")}/v1/traces`,
    });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "openinference.project.name": options.projectName ?? "burmalda",
    }),
    spanProcessors: [
      options.simple
        ? new SimpleSpanProcessor(exporter)
        : new BatchSpanProcessor(exporter),
    ],
  });
  const otel = provider.getTracer("burmalda");

  const tracer: Tracer = {
    startSpan(
      name: string,
      kind: SpanKind,
      attributes?: Attributes,
      parent?: Span,
    ): Span {
      const parentOtel =
        parent instanceof OtelSpanAdapter ? parent.span : undefined;
      const ctx = parentOtel
        ? trace.setSpan(context.active(), parentOtel)
        : context.active();
      const span = otel.startSpan(
        name,
        {
          attributes: { "openinference.span.kind": kind, ...clean(attributes) },
        },
        ctx,
      );
      return new OtelSpanAdapter(span);
    },
  };

  return {
    tracer,
    shutdown: async () => {
      await provider.forceFlush().catch(() => undefined);
      await provider.shutdown().catch(() => undefined);
    },
  };
}

class OtelSpanAdapter implements Span {
  constructor(readonly span: OtelSpan) {}

  setAttributes(attributes: Attributes): void {
    this.span.setAttributes(clean(attributes));
  }

  recordError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.span.recordException(err);
    this.span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }

  end(): void {
    this.span.end();
  }

  /** trace id для связи логов с трейсами. */
  get traceId(): string {
    return this.span.spanContext().traceId;
  }
}

function clean(
  attributes?: Attributes,
): Record<string, string | number | boolean | string[]> {
  const result: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/** trace id спана, если он из OpenTelemetry (для полей логов). */
export function traceIdOf(span: Span): string | undefined {
  return span instanceof OtelSpanAdapter ? span.traceId : undefined;
}
