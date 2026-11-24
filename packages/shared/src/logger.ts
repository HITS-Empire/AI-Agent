import { pino, type DestinationStream, type Logger } from "pino";

export interface LoggerOptions {
  /** stderr — для CLI, чтобы логи не смешивались с диалогом в stdout. */
  stderr?: boolean;
  /** Подмена потока (тесты). */
  destination?: DestinationStream;
}

/**
 * Структурированный JSON-логгер: одна строка JSON на запись, время ISO 8601, уровень строкой,
 * service и, где есть, sessionId/taskId/traceId (traceId совпадает с трейсом в Phoenix).
 * Секреты (ключи, токены, пароли) в логи не пишем — redact ниже страхует от случайностей.
 */
export function createLogger(
  service: string,
  level = "info",
  options: LoggerOptions = {},
): Logger {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
      redact: {
        paths: [
          "apiKey",
          "token",
          "password",
          "authorization",
          "*.apiKey",
          "*.token",
          "*.password",
          "*.authorization",
          "headers.authorization",
          "headers.Authorization",
        ],
        censor: "[redacted]",
      },
    },
    options.destination ?? pino.destination(options.stderr ? 2 : 1),
  );
}

export type { Logger };
