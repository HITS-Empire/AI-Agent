import { Markup, Telegraf } from "telegraf";
import type { AgentEvent } from "@burmalda/shared";
import { PROJECT_NAME, createLogger, loadConfig } from "@burmalda/shared";
import {
  EventBus,
  createAgentQueue,
  enqueueAgentTask,
  ownerSession,
} from "@burmalda/queue";
import {
  approvalButtons,
  formatOwnerReply,
  isOwner,
  parseApprovalCallback,
} from "./format";

/**
 * Telegram-бот «бурмалды». Отвечает только владельцу (TELEGRAM_OWNER_ID).
 * Текст кладётся в общую очередь, ответы и кнопки подтверждения приходят из events:<sessionId>.
 * Сессия та же, что у CLI, поэтому разговор можно продолжить там.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("telegram", config.logLevel);

  if (!config.telegram.token) {
    throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  }
  if (!config.telegram.ownerId) {
    throw new Error("Не задан TELEGRAM_OWNER_ID");
  }

  const { sessionId } = ownerSession();
  const ownerId = config.telegram.ownerId;
  const chatId = Number(ownerId);
  const queue = createAgentQueue(config.redisUrl);
  const bus = new EventBus(config.redisUrl);
  const bot = new Telegraf(config.telegram.token);

  bot.use(async (ctx, next) => {
    if (!isOwner(ctx.from?.id, ownerId)) return;
    await next();
  });

  bot.start((ctx) =>
    ctx.reply(
      formatOwnerReply(
        "Персональный ассистент. Пиши задачу — начатое здесь можно продолжить в CLI.",
      ),
    ),
  );

  bot.on("text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text) return;
    await enqueueAgentTask(queue, {
      sessionId,
      channel: "telegram",
      text,
    });
    await ctx.reply(formatOwnerReply("думаю…"));
  });

  bot.action(/^apr:[0-9a-fA-F-]{36}:[yn]$/, async (ctx) => {
    const data = "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";
    const parsed = parseApprovalCallback(data);
    if (!parsed) return;
    await bus.answerApproval(parsed.requestId, parsed.approved);
    await ctx.answerCbQuery(parsed.approved ? "Разрешено" : "Отклонено");
    await ctx.editMessageText(
      formatOwnerReply(parsed.approved ? "разрешено" : "отклонено"),
    );
  });

  await bus.subscribe(sessionId, (event) => {
    void deliver(bot, chatId, event).catch((error: unknown) =>
      log.warn({ error: String(error) }, "не удалось отправить сообщение"),
    );
  });

  await bot.telegram
    .setMyDescription(`${PROJECT_NAME} — персональный ИИ-ассистент`)
    .catch(() => undefined);
  await bot.telegram
    .setMyShortDescription(`${PROJECT_NAME} — персональный ассистент`)
    .catch(() => undefined);

  const stop = async () => {
    bot.stop("shutdown");
    await queue.close();
    await bus.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  log.info({ sessionId }, "telegram bot started");
  await bot.launch();
}

async function deliver(
  bot: Telegraf,
  chatId: number,
  event: AgentEvent,
): Promise<void> {
  if (!Number.isFinite(chatId)) return;
  if (event.type === "tool_call") {
    await bot.telegram.sendMessage(
      chatId,
      formatOwnerReply(`${event.name} ${event.argsPreview}`.trim()),
    );
    return;
  }
  if (event.type === "approval_required") {
    const buttons = approvalButtons(event.requestId);
    await bot.telegram.sendMessage(
      chatId,
      formatOwnerReply(event.text),
      Markup.inlineKeyboard([
        Markup.button.callback("Разрешить", buttons.yes),
        Markup.button.callback("Отклонить", buttons.no),
      ]),
    );
    return;
  }
  if (event.type === "message") {
    await bot.telegram.sendMessage(chatId, formatOwnerReply(event.text));
    return;
  }
  if (event.type === "error") {
    await bot.telegram.sendMessage(chatId, formatOwnerReply(event.text));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
