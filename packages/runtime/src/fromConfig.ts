import { resolve } from "node:path";
import {
  GatewayClient,
  ToolRegistry,
  collectAgentsMd,
  discoverSkills,
  loadMcpConfig,
  noopTracer,
} from "@burmalda/core";
import {
  createMarketplaceAdapter,
  type MarketplaceAdapter,
  type MarketplaceId,
} from "@burmalda/integrations";
import {
  LongTermMemory,
  ProfileStore,
  ShortTermMemory,
  UsageStore,
  createPool,
  extractFacts,
  memoryTools,
  migrate,
} from "@burmalda/memory";
import { createTracing, type Tracing } from "@burmalda/observability";
import type { AppConfig, Logger } from "@burmalda/shared";
import { AgentRuntime } from "./runtime";
import { marketplaceSearchTool } from "./tools/marketplace";

export const EMBEDDING_DIMENSIONS = 1024; // bge-m3

export interface RuntimeBundle {
  runtime: AgentRuntime;
  gateway: GatewayClient;
  tools: ToolRegistry;
  usageStore: UsageStore;
  sessions: ShortTermMemory;
  shutdown(): Promise<void>;
}

/**
 * Собрать рантайм из окружения: шлюз, Postgres-память, инструменты, MCP, трассировка.
 * Используется worker и CLI --direct, чтобы поведение было одинаковым.
 */
export async function createRuntimeFromConfig(
  config: AppConfig,
  log: Logger,
  options: {
    serviceName: string;
    root?: string;
    extraTools?: (tools: ToolRegistry) => void;
  } = {
    serviceName: "burmalda",
  },
): Promise<RuntimeBundle> {
  const root = options.root ?? process.cwd();
  if (!config.gateway.apiKey) {
    throw new Error(
      "Не задан LITELLM_API_KEY (виртуальный ключ шлюза, см. README)",
    );
  }

  const gateway = new GatewayClient({
    baseUrl: config.gateway.baseUrl,
    apiKey: config.gateway.apiKey,
  });

  const pool = createPool(config.databaseUrl);
  await migrate(pool, EMBEDDING_DIMENSIONS);
  const sessions = new ShortTermMemory(pool);
  const profile = new ProfileStore(pool);
  const usageStore = new UsageStore(pool);
  const longTerm = new LongTermMemory(pool, {
    embedder: gateway,
    embedModel: config.gateway.models.embed,
    onEmbeddingError: (error) =>
      log.warn(
        { error: String(error) },
        "эмбеддинги недоступны, память работает без вектора",
      ),
  });

  const tools = new ToolRegistry();
  for (const tool of memoryTools(longTerm, profile)) tools.register(tool);
  const adapters = marketplaceAdapters(process.env.MARKETPLACES, log);
  if (adapters.length) tools.register(marketplaceSearchTool(adapters));
  options.extraTools?.(tools);

  const otelEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const tracing: Tracing | undefined = otelEndpoint
    ? createTracing({
        serviceName: process.env.OTEL_SERVICE_NAME ?? options.serviceName,
        endpoint: otelEndpoint,
      })
    : undefined;

  const workspace = resolve(root, config.sandbox.workspaceDir);
  const runtime = new AgentRuntime({
    llm: gateway,
    models: config.gateway.models,
    tools,
    sessions,
    facts: longTerm,
    profile,
    usageStore,
    context: {
      ...config.context,
      providerOverheadTokens: Number(
        process.env.BURMALDA_PROVIDER_OVERHEAD_TOKENS ?? 1700,
      ),
    },
    tracer: tracing?.tracer ?? noopTracer,
    instructions: () => collectAgentsMd(workspace, workspace),
    skills: () => discoverSkills([resolve(root, "skills")]),
    extractFacts: (messages, known, sessionId, llm) =>
      extractFacts({
        llm,
        model: config.gateway.models.fast,
        messages,
        known,
        sessionId,
      }),
    log: (level, data, msg) => log[level](data, msg),
  });

  const mcp = await loadMcpConfig(
    resolve(root, process.env.MCP_CONFIG ?? "config/mcp.json"),
  );
  for (const skipped of mcp.skipped) log.info(skipped, "MCP-сервер пропущен");
  const mcpTools = await runtime.connectMcp(mcp.servers);
  log.info(
    { tools: tools.names().length, mcpTools: mcpTools.length },
    "инструменты готовы",
  );

  return {
    runtime,
    gateway,
    tools,
    usageStore,
    sessions,
    async shutdown() {
      await runtime.close();
      await tracing?.shutdown();
      await pool.end();
    },
  };
}

function marketplaceAdapters(
  raw: string | undefined,
  log: Logger,
): MarketplaceAdapter[] {
  const ids = (raw ?? "yandex_market")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as MarketplaceId[];
  const adapters: MarketplaceAdapter[] = [];
  for (const id of ids) {
    try {
      adapters.push(createMarketplaceAdapter(id));
    } catch (error) {
      log.info(
        { marketplace: id, error: String(error) },
        "адаптер маркетплейса не готов",
      );
    }
  }
  return adapters;
}
