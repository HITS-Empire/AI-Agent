import { pino, type Logger } from "pino";

/**
 * Структурированный JSON-логгер. Каждая запись несёт service и, где есть, sessionId/taskId/traceId.
 * Секреты (ключи, токены) в логи не пишем — redact ниже страхует от случайностей.
 */
export function createLogger(service: string, level = "info"): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: [
        "apiKey",
        "token",
        "authorization",
        "*.apiKey",
        "*.token",
        "*.authorization",
        "headers.authorization",
      ],
      censor: "[redacted]",
    },
  });
}

export type { Logger };
