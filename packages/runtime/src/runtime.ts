import { randomUUID } from "node:crypto";
import {
  ContextManager,
  McpClient,
  SUMMARY_PREFIX,
  UsageMeter,
  noopTracer,
  registerMcpTools,
  runAgent,
  type ChatMessage,
  type CompactionResult,
  type LlmClient,
  type McpServerConfig,
  type ModelUsage,
  type ToolRegistry,
  type Tracer,
} from "@burmalda/core";
import type { AgentEvent, Channel } from "@burmalda/shared";
import { buildSystemPrompt } from "./prompt";

/** Хранилище истории сессии (ShortTermMemory на Postgres или память процесса в тестах). */
export interface SessionStore {
  ensureSession(sessionId: string, ownerId: string): Promise<void>;
  append(
    sessionId: string,
    channel: string,
    message: ChatMessage,
  ): Promise<void>;
  load(sessionId: string): Promise<ChatMessage[]>;
  compact(
    sessionId: string,
    summary: string,
    keptMessages: number,
  ): Promise<number>;
}

export interface FactStore {
  recall(
    ownerId: string,
    query: string,
    limit?: number,
  ): Promise<Array<{ text: string }>>;
  remember(
    ownerId: string,
    text: string,
    tags?: string[],
    source?: string,
  ): Promise<unknown>;
}

export interface RuntimeDeps {
  llm: LlmClient;
  models: { main: string; fast: string };
  tools: ToolRegistry;
  sessions: SessionStore;
  facts?: FactStore;
  profile?: { all(ownerId: string): Promise<Record<string, string>> };
  usageStore?: {
    record(
      entry: { sessionId: string; taskId: string; channel: string },
      byModel: Array<[string, ModelUsage]>,
    ): Promise<void>;
  };
  /** Извлечение фактов после задачи (дешёвая модель). Без него — только явный remember. */
  extractFacts?: (
    messages: ChatMessage[],
    known: string[],
    sessionId: string,
    /** Клиент с учётом расхода: токены извлечения тоже попадают в журнал. */
    llm: LlmClient,
  ) => Promise<string[]>;
  /** AGENTS.md и скиллы (часть B). Ошибки не роняют задачу. */
  instructions?: () => Promise<Array<{ path: string; content: string }>>;
  skills?: () => Promise<
    Array<{ name: string; description: string; path: string }>
  >;
  context: {
    window: number;
    compactAt: number;
    /** Скрытые инструкции провайдера в каждом запросе (chatgpt/ — ~1600 токенов). */
    providerOverheadTokens?: number;
  };
  tracer?: Tracer;
  log?: (
    level: "info" | "warn" | "error",
    data: Record<string, unknown>,
    msg: string,
  ) => void;
  now?: () => Date;
  maxSteps?: number;
}

export interface TaskInput {
  text: string;
  sessionId: string;
  ownerId: string;
  channel: Channel;
  taskId?: string;
}

export interface TaskHooks {
  onEvent?: (event: AgentEvent) => void;
  requestApproval?: (text: string) => Promise<boolean>;
  signal?: AbortSignal;
}

export interface TaskResult {
  taskId: string;
  text: string;
  usage: ReturnType<UsageMeter["total"]>;
  byModel: Array<[string, ModelUsage]>;
  compactions: CompactionResult[];
  stoppedBy: string;
  /** Фоновое извлечение фактов (ждать не обязательно; в тестах удобно). */
  background: Promise<void>;
}

/**
 * Рантайм агента: один на процесс worker (или CLI --direct).
 * Задача = загрузить сессию → собрать system prompt → цикл агента с compaction → сохранить → учесть расход.
 * Задачи одной сессии выполняются строго по очереди.
 */
export class AgentRuntime {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly mcpClients: McpClient[] = [];
  private readonly warned = new Set<string>();

  constructor(private readonly deps: RuntimeDeps) {}

  /** Подключить MCP-серверы и зарегистрировать их инструменты. Недоступный сервер не мешает остальным. */
  async connectMcp(servers: McpServerConfig[]): Promise<string[]> {
    const names: string[] = [];
    for (const server of servers) {
      const client = new McpClient(server, {
        onLog: (line) =>
          this.log("info", { mcp: server.name }, line.slice(0, 500)),
      });
      try {
        await client.connect();
        names.push(...(await registerMcpTools(client, this.deps.tools)));
        this.mcpClients.push(client);
      } catch (error) {
        this.log(
          "warn",
          { mcp: server.name, error: String(error) },
          "MCP-сервер недоступен",
        );
        await client.close().catch(() => undefined);
      }
    }
    return names;
  }

  async close(): Promise<void> {
    await Promise.all(
      this.mcpClients.map((c) => c.close().catch(() => undefined)),
    );
  }

  run(input: TaskInput, hooks: TaskHooks = {}): Promise<TaskResult> {
    const previous = this.locks.get(input.sessionId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.execute(input, hooks));
    this.locks.set(input.sessionId, next);
    void next
      .finally(() => {
        if (this.locks.get(input.sessionId) === next)
          this.locks.delete(input.sessionId);
      })
      .catch(() => undefined);
    return next;
  }

  private async execute(
    input: TaskInput,
    hooks: TaskHooks,
  ): Promise<TaskResult> {
    const { deps } = this;
    const taskId = input.taskId ?? randomUUID();
    const tracer = deps.tracer ?? noopTracer;
    const emit = (event: AgentEvent) => hooks.onEvent?.(event);
    const meter = new UsageMeter();
    const compactions: CompactionResult[] = [];

    const root = tracer.startSpan("burmalda.task", "CHAIN", {
      "session.id": input.sessionId,
      "burmalda.task_id": taskId,
      "burmalda.channel": input.channel,
      "input.value": input.text.slice(0, 4000),
    });

    try {
      await deps.sessions.ensureSession(input.sessionId, input.ownerId);
      const [history, facts, profile, agentsMd, skills] = await Promise.all([
        deps.sessions.load(input.sessionId),
        this.safe(
          "recall",
          () => deps.facts?.recall(input.ownerId, input.text, 6),
          [],
        ),
        this.safe("profile", () => deps.profile?.all(input.ownerId), {}),
        this.safe("AGENTS.md", () => deps.instructions?.(), []),
        this.safe("skills", () => deps.skills?.(), []),
      ]);
      const knownFacts = (facts ?? []).map((f) => f.text);

      const system: ChatMessage = {
        role: "system",
        content: buildSystemPrompt({
          now: deps.now?.() ?? new Date(),
          profile: profile ?? {},
          facts: knownFacts,
          agentsMd: agentsMd ?? [],
          skills: skills ?? [],
          channel: input.channel,
        }),
      };
      const user: ChatMessage = { role: "user", content: input.text };
      const messages: ChatMessage[] = [system, ...history, user];
      await deps.sessions.append(input.sessionId, input.channel, user);
      const firstNew = messages.length - 1;

      const context = new ContextManager({
        llm: deps.llm,
        model: deps.models.fast,
        contextWindow: deps.context.window,
        compactAt: deps.context.compactAt,
        overheadTokens:
          Math.ceil(JSON.stringify(deps.tools.specs()).length / 3) +
          (deps.context.providerOverheadTokens ?? 0),
        pinnedHead: 1,
        tracer,
        parentSpan: root,
        usage: meter,
        sessionId: input.sessionId,
      });

      emit({ type: "status", taskId, text: "думаю…" });
      const result = await runAgent({
        llm: deps.llm,
        model: deps.models.main,
        tools: deps.tools,
        messages,
        maxSteps: deps.maxSteps ?? 30,
        tracer,
        parentSpan: root,
        usage: meter,
        ctx: {
          sessionId: input.sessionId,
          taskId,
          ownerId: input.ownerId,
          workspaceRoot: process.env.WORKSPACE_DIR ?? process.cwd(),
          ...(hooks.signal ? { signal: hooks.signal } : {}),
          requestApproval: hooks.requestApproval ?? (async () => false),
        },
        onMessage: (message) =>
          deps.sessions.append(input.sessionId, input.channel, message),
        beforeStep: async (current, info) => {
          const compaction = await context.maybeCompact(current, info);
          if (!compaction) return;
          compactions.push(compaction);
          if (compaction.kind === "summarized" && compaction.summary) {
            await deps.sessions.compact(
              input.sessionId,
              compaction.summary,
              compaction.keptMessages,
            );
            // точное число токенов прошлого запроса больше не соответствует истории
            info.lastPromptTokens = undefined;
            info.messagesAtLastRequest = undefined;
          }
          emit({
            type: "status",
            taskId,
            text: `контекст сжат: ${compaction.tokensBefore} → ${compaction.tokensAfter} токенов`,
          });
        },
        onEvent: (event) => {
          if (event.type === "tool_call")
            emit({
              type: "tool_call",
              taskId,
              name: event.name,
              argsPreview: event.args.slice(0, 200),
            });
          if (event.type === "tool_result")
            emit({
              type: "tool_result",
              taskId,
              name: event.name,
              ok: event.ok,
            });
        },
      });

      const total = meter.total();
      emit({ type: "message", taskId, text: result.finalText });
      emit({
        type: "done",
        taskId,
        usage: {
          promptTokens: total.promptTokens,
          completionTokens: total.completionTokens,
          totalTokens: total.totalTokens,
        },
      });
      root.setAttributes({
        "output.value": result.finalText.slice(0, 4000),
        "llm.token_count.total": total.totalTokens,
        "burmalda.cost_usd": total.costUsd,
      });

      await this.safe(
        "usage",
        () =>
          deps.usageStore?.record(
            { sessionId: input.sessionId, taskId, channel: input.channel },
            meter.models(),
          ),
        undefined,
      );
      this.log(
        "info",
        {
          sessionId: input.sessionId,
          taskId,
          channel: input.channel,
          steps: result.steps,
          tokens: total.totalTokens,
          costUsd: total.costUsd,
          compactions: compactions.length,
        },
        "задача выполнена",
      );

      const newMessages = messages
        .slice(Math.max(firstNew, 1))
        .filter((m) => m.role !== "system");
      const background = this.learn(input, taskId, newMessages, knownFacts);

      return {
        taskId,
        text: result.finalText,
        usage: total,
        byModel: meter.models(),
        compactions,
        stoppedBy: result.stoppedBy,
        background,
      };
    } catch (error) {
      root.recordError(error);
      emit({
        type: "error",
        taskId,
        text: error instanceof Error ? error.message : String(error),
      });
      this.log(
        "error",
        { sessionId: input.sessionId, taskId, error: String(error) },
        "задача упала",
      );
      throw error;
    } finally {
      root.end();
    }
  }

  private async learn(
    input: TaskInput,
    taskId: string,
    messages: ChatMessage[],
    known: string[],
  ): Promise<void> {
    const { extractFacts, facts } = this.deps;
    if (!extractFacts || !facts) return;
    const meter = new UsageMeter();
    const llm = meteredClient(this.deps.llm, meter);
    try {
      const found = await extractFacts(messages, known, input.sessionId, llm);
      for (const fact of found)
        await facts.remember(input.ownerId, fact, [], "extract");
      if (found.length)
        this.log(
          "info",
          { sessionId: input.sessionId, facts: found.length },
          "факты сохранены",
        );
    } catch (error) {
      this.log(
        "warn",
        { error: String(error) },
        "извлечение фактов не удалось",
      );
    } finally {
      if (meter.models().length)
        await this.safe(
          "usage",
          () =>
            this.deps.usageStore?.record(
              { sessionId: input.sessionId, taskId, channel: input.channel },
              meter.models(),
            ),
          undefined,
        );
    }
  }

  private async safe<T>(
    what: string,
    fn: () => Promise<T> | undefined,
    fallback: T,
  ): Promise<T> {
    try {
      return (await fn()) ?? fallback;
    } catch (error) {
      // одно и то же предупреждение (например, «не реализовано») — один раз за процесс
      const key = `${what}:${String(error)}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.log(
          "warn",
          { part: what, error: String(error) },
          `${what}: пропущено`,
        );
      }
      return fallback;
    }
  }

  private log(
    level: "info" | "warn" | "error",
    data: Record<string, unknown>,
    msg: string,
  ): void {
    this.deps.log?.(level, data, msg);
  }
}

/** История в памяти процесса — для тестов и запуска без Postgres. */
export class InMemorySessionStore implements SessionStore {
  private readonly data = new Map<
    string,
    { messages: ChatMessage[]; summary?: string }
  >();

  async ensureSession(sessionId: string): Promise<void> {
    if (!this.data.has(sessionId)) this.data.set(sessionId, { messages: [] });
  }

  async append(
    sessionId: string,
    _channel: string,
    message: ChatMessage,
  ): Promise<void> {
    await this.ensureSession(sessionId);
    this.data.get(sessionId)!.messages.push(message);
  }

  async load(sessionId: string): Promise<ChatMessage[]> {
    const session = this.data.get(sessionId);
    if (!session) return [];
    const history = [...session.messages];
    return session.summary
      ? [
          { role: "system", content: `${SUMMARY_PREFIX}\n${session.summary}` },
          ...history,
        ]
      : history;
  }

  async compact(
    sessionId: string,
    summary: string,
    keptMessages: number,
  ): Promise<number> {
    const session = this.data.get(sessionId);
    if (!session) return 0;
    const removed = Math.max(0, session.messages.length - keptMessages);
    session.messages = session.messages.slice(removed);
    session.summary = summary;
    return removed;
  }
}

/** Обёртка, которая записывает расход каждого вызова в UsageMeter. */
export function meteredClient(llm: LlmClient, meter: UsageMeter): LlmClient {
  return {
    async chat(request, signal) {
      const response = await llm.chat(request, signal);
      meter.record(request.model, response);
      return response;
    },
  };
}
