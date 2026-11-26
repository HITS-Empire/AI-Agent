/**
 * Конфигурация из переменных окружения. Секреты только из env, никогда из кода.
 */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Не задана переменная окружения ${name}`);
  }
  return value;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Переменная окружения ${name} должна быть числом`);
  }
  return value;
}

export type ShellMode = "sandbox" | "host";

export interface AppConfig {
  gateway: {
    baseUrl: string;
    apiKey: string;
    models: { main: string; fast: string; embed: string };
  };
  context: { window: number; compactAt: number };
  databaseUrl: string;
  redisUrl: string;
  telegram: { token: string; ownerId: string };
  sandbox: { image: string; shellMode: ShellMode; workspaceDir: string };
  logLevel: string;
}

export function loadConfig(): AppConfig {
  const shellMode = env("SHELL_MODE", "sandbox");
  if (shellMode !== "sandbox" && shellMode !== "host") {
    throw new Error("SHELL_MODE должен быть sandbox или host");
  }

  return {
    gateway: {
      baseUrl: env("LITELLM_BASE_URL", "http://127.0.0.1:4000"),
      apiKey: env("LITELLM_API_KEY", ""),
      models: {
        main: env("BURMALDA_MODEL_MAIN", "burmalda-main"),
        fast: env("BURMALDA_MODEL_FAST", "burmalda-fast"),
        embed: env("BURMALDA_MODEL_EMBED", "burmalda-embed"),
      },
    },
    context: {
      window: envNumber("BURMALDA_CONTEXT_WINDOW", 200_000),
      compactAt: envNumber("BURMALDA_COMPACT_AT", 0.7),
    },
    databaseUrl: env(
      "DATABASE_URL",
      "postgresql://burmalda:burmalda@127.0.0.1:5432/burmalda",
    ),
    redisUrl: env("REDIS_URL", "redis://127.0.0.1:6379"),
    telegram: {
      token: env("TELEGRAM_BOT_TOKEN", ""),
      ownerId: env("TELEGRAM_OWNER_ID", ""),
    },
    sandbox: {
      image: env("SANDBOX_IMAGE", "burmalda-sandbox:local"),
      shellMode,
      workspaceDir: env("WORKSPACE_DIR", "."),
    },
    logLevel: env("LOG_LEVEL", "info"),
  };
}
