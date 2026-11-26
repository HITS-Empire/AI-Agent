import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  GatewayClient,
  ToolRegistry,
  collectAgentsMd,
  discoverSkills,
  fsTools,
  loadMcpConfig,
  loadSkillTool,
  noopTracer,
} from "@burmalda/core";
import {
  createBrowserRenderer,
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
  for (const tool of fsTools()) tools.register(tool);
  tools.register(loadSkillTool([resolve(root, "skills")]));
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
  await mkdir(workspace, { recursive: true });
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
    workspaceRoot: workspace,
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

const KNOWN_MARKETPLACES: readonly MarketplaceId[] = [
  "yandex_market",
  "ozon",
  "wildberries",
];

function marketplaceAdapters(
  raw: string | undefined,
  log: Logger,
): MarketplaceAdapter[] {
  const renderer = createBrowserRenderer();
  const ids = (raw ?? KNOWN_MARKETPLACES.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const adapters: MarketplaceAdapter[] = [];
  for (const id of ids) {
    if (!KNOWN_MARKETPLACES.includes(id as MarketplaceId)) {
      log.warn({ marketplace: id }, "неизвестный маркетплейс в MARKETPLACES");
      continue;
    }
    adapters.push(createMarketplaceAdapter(id as MarketplaceId, renderer));
  }
  return adapters;
}
