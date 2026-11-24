import type { ChatMessage, LlmClient } from "../llm/types";
import { UsageMeter } from "../llm/usage";
import { tracedClient } from "../llm/traced";
import type { StepInfo } from "../agent/loop";
import { noopTracer, type Span, type Tracer } from "../observability/tracer";

/** Грубая оценка токенов, пока нет точной цифры от шлюза. Для смеси русского и английского ~3 символа на токен. */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    chars += (message.content ?? "").length + 8;
    if (message.role === "assistant" && message.tool_calls) {
      chars += JSON.stringify(message.tool_calls).length;
    }
  }
  return Math.ceil(chars / 3);
}

/**
 * Размер контекста: если есть точное число токенов прошлого запроса — к нему прибавляем
 * оценку только для сообщений, добавленных с тех пор.
 */
export function contextTokens(
  messages: ChatMessage[],
  info?: StepInfo,
  /** Невидимая в messages часть запроса (схемы инструментов, инструкции провайдера) — только для оценки. */
  overheadTokens = 0,
): number {
  if (
    info?.lastPromptTokens !== undefined &&
    info.messagesAtLastRequest !== undefined &&
    info.messagesAtLastRequest <= messages.length
  ) {
    return (
      info.lastPromptTokens +
      estimateTokens(messages.slice(info.messagesAtLastRequest))
    );
  }
  return estimateTokens(messages) + overheadTokens;
}

export interface CompactionOptions {
  llm: LlmClient;
  /** Дешёвая модель для саммари (burmalda-fast). */
  model: string;
  contextWindow: number;
  /** Доля окна, после которой сжимаем (0.7 = 70%). */
  compactAt: number;
  /**
   * Токены запроса, которых нет в messages: схемы инструментов и скрытые инструкции провайдера
   * (chatgpt/ добавляет ~1,6 тыс.). Учитываются, пока нет точной цифры от шлюза.
   */
  overheadTokens?: number;
  /** Сколько последних сообщений оставить дословно (граница сдвигается к ближайшему user). */
  keepRecent?: number;
  /** Сколько первых сообщений не трогать никогда (базовый system prompt). По умолчанию 1. */
  pinnedHead?: number;
  /** Выводы инструментов длиннее этого в старой части урезаются до саммаризации. */
  pruneToolOutputOver?: number;
  tracer?: Tracer;
  parentSpan?: Span;
  usage?: UsageMeter;
  sessionId?: string;
}

export interface CompactionResult {
  tokensBefore: number;
  tokensAfter: number;
  /** pruned — только урезали выводы инструментов; summarized — заменили старую часть саммари. */
  kind: "pruned" | "summarized";
  summary?: string;
  /** Сколько сообщений диалога (после pinnedHead и саммари) осталось дословно. */
  keptMessages: number;
  removedMessages: number;
}

export const SUMMARY_PREFIX = "Сводка предыдущей части разговора (compaction):";

const SUMMARY_SYSTEM_PROMPT = `Ты сжимаешь историю диалога ассистента «бурмалда» с владельцем, чтобы освободить контекст.
Напиши сводку по-русски, которая позволит продолжить работу без исходной истории:
- цели и просьбы владельца, в том числе невыполненные;
- принятые решения, договорённости и предпочтения владельца;
- важные факты и результаты инструментов: пути файлов, команды, идентификаторы, числа, ссылки — дословно;
- что сделано и что осталось сделать, на чём остановились.
Не выдумывай. Не пересказывай вежливости. Маркированный список, не длиннее 400 слов.`;

const PRUNE_MARKER = "…[вывод инструмента сокращён при compaction]";

/**
 * Управление контекстным окном:
 * 1) дешёвый шаг — урезать длинные выводы инструментов в старой части истории;
 * 2) если не помогло — заменить старую часть саммари от дешёвой модели.
 * Целостность пар assistant(tool_calls) → tool сохраняется: граница режется только перед сообщением user.
 */
export class ContextManager {
  private readonly keepRecent: number;
  private readonly pinnedHead: number;
  private readonly pruneOver: number;

  constructor(private readonly options: CompactionOptions) {
    this.keepRecent = options.keepRecent ?? 8;
    this.pinnedHead = options.pinnedHead ?? 1;
    this.pruneOver = options.pruneToolOutputOver ?? 2000;
  }

  get threshold(): number {
    return Math.floor(this.options.contextWindow * this.options.compactAt);
  }

  async maybeCompact(
    messages: ChatMessage[],
    info?: StepInfo,
  ): Promise<CompactionResult | null> {
    const tokensBefore = contextTokens(
      messages,
      info,
      this.options.overheadTokens ?? 0,
    );
    if (tokensBefore < this.threshold) return null;

    const tracer = this.options.tracer ?? noopTracer;
    const span = tracer.startSpan(
      "context.compaction",
      "CHAIN",
      {
        "burmalda.tokens_before": tokensBefore,
        "session.id": this.options.sessionId,
      },
      this.options.parentSpan,
    );

    try {
      const pruned = this.prune(messages);
      if (pruned > 0) {
        const afterPrune = estimateTokens(messages);
        if (afterPrune < this.threshold * 0.8) {
          const result: CompactionResult = {
            tokensBefore,
            tokensAfter: afterPrune,
            kind: "pruned",
            keptMessages: messages.length - this.pinnedHead,
            removedMessages: 0,
          };
          span.setAttributes({
            "burmalda.compaction_kind": "pruned",
            "burmalda.tokens_after": afterPrune,
          });
          return result;
        }
      }

      const result = await this.summarize(messages, tokensBefore, span);
      span.setAttributes({
        "burmalda.compaction_kind": result?.kind ?? "none",
        "burmalda.tokens_after": result?.tokensAfter,
      });
      return result;
    } catch (error) {
      span.recordError(error);
      throw error;
    } finally {
      span.end();
    }
  }

  /** Урезает длинные выводы инструментов вне хвоста. Возвращает число изменённых сообщений. */
  prune(messages: ChatMessage[]): number {
    const tailStart = Math.max(
      this.pinnedHead,
      messages.length - this.keepRecent,
    );
    let changed = 0;
    for (let i = this.pinnedHead; i < tailStart; i++) {
      const message = messages[i];
      if (
        message?.role === "tool" &&
        message.content.length > this.pruneOver &&
        !message.content.endsWith(PRUNE_MARKER)
      ) {
        messages[i] = {
          ...message,
          content: `${message.content.slice(0, Math.floor(this.pruneOver / 4))}\n${PRUNE_MARKER}`,
        };
        changed++;
      }
    }
    return changed;
  }

  /** Индекс в messages, с которого начинается дословный хвост, или null, если резать нечего. */
  findCut(messages: ChatMessage[]): number | null {
    let cut = messages.length - this.keepRecent;
    while (cut > this.pinnedHead && messages[cut]?.role !== "user") cut--;
    if (cut <= this.pinnedHead) {
      // В хвосте нет user — ищем ближайший user дальше от начала, но так, чтобы что-то осталось
      for (let i = messages.length - 1; i > this.pinnedHead; i--) {
        if (messages[i]?.role === "user") return i;
      }
      // Одна длинная задача (user и дальше только assistant/tool): режем перед сообщением assistant —
      // с него начинается группа «вызов инструментов → результаты», так пары не рвутся.
      // Сам запрос владельца уходит в сводку (промпт сводки требует сохранить цели).
      for (
        let i = messages.length - this.keepRecent;
        i > this.pinnedHead + 1;
        i--
      ) {
        if (messages[i]?.role === "assistant") return i;
      }
      return null;
    }
    return cut;
  }

  private async summarize(
    messages: ChatMessage[],
    tokensBefore: number,
    span?: Span,
  ): Promise<CompactionResult | null> {
    const cut = this.findCut(messages);
    if (cut === null) return null;
    const old = messages.slice(this.pinnedHead, cut);
    if (old.length === 0) return null;

    const llm = tracedClient(
      this.options.llm,
      this.options.tracer ?? noopTracer,
      span,
    );
    const response = await llm.chat({
      model: this.options.model,
      messages: [
        { role: "system", content: SUMMARY_SYSTEM_PROMPT },
        { role: "user", content: renderTranscript(old) },
      ],
      user: this.options.sessionId,
      metadata: { tags: ["burmalda", "compaction"] },
    });
    this.options.usage?.record(this.options.model, response);

    const summary = response.choices[0]?.message.content?.trim();
    if (!summary) throw new Error("Compaction: модель вернула пустую сводку");

    messages.splice(this.pinnedHead, old.length, {
      role: "system",
      content: `${SUMMARY_PREFIX}\n${summary}`,
    });

    return {
      tokensBefore,
      tokensAfter: estimateTokens(messages),
      kind: "summarized",
      summary,
      keptMessages: messages.length - this.pinnedHead - 1,
      removedMessages: old.length,
    };
  }
}

/** Текстовая расшифровка истории для саммаризации; длинные выводы урезаются. */
export function renderTranscript(
  messages: ChatMessage[],
  toolLimit = 1500,
): string {
  const lines: string[] = [];
  for (const message of messages) {
    switch (message.role) {
      case "system":
        lines.push(`[system] ${message.content}`);
        break;
      case "user":
        lines.push(`[владелец] ${message.content}`);
        break;
      case "assistant":
        if (message.content) lines.push(`[ассистент] ${message.content}`);
        for (const call of message.tool_calls ?? []) {
          lines.push(
            `[вызов ${call.function.name}] ${call.function.arguments.slice(0, 500)}`,
          );
        }
        break;
      case "tool":
        lines.push(
          `[результат] ${message.content.length > toolLimit ? `${message.content.slice(0, toolLimit)}…` : message.content}`,
        );
        break;
    }
  }
  return lines.join("\n");
}
