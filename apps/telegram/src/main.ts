import { Telegraf } from "telegraf";
import { PROJECT_NAME, createLogger, loadConfig } from "@burmalda/shared";

/**
 * Telegram-бот «бурмалды». Отвечает только владельцу (TELEGRAM_OWNER_ID).
 * TODO(B): текст → AgentTask в общую очередь; подписка на events:<sessionId> → ответы и кнопки подтверждения.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger("telegram", config.logLevel);

  if (!config.telegram.token) {
    throw new Error("Не задан TELEGRAM_BOT_TOKEN");
  }

  const bot = new Telegraf(config.telegram.token);

  bot.use(async (ctx, next) => {
    if (String(ctx.from?.id) !== config.telegram.ownerId) return;
    await next();
  });

  bot.start((ctx) =>
    ctx.reply(
      `🤖 ${PROJECT_NAME.toUpperCase()}\nПерсональный ассистент. Пиши задачу — начатое здесь можно продолжить в CLI.`,
    ),
  );

  bot.on("text", (ctx) =>
    ctx.reply(`${PROJECT_NAME}: очередь задач ещё не подключена`),
  );

  await bot.telegram.setMyDescription(
    `${PROJECT_NAME} — персональный ИИ-ассистент`,
  );
  log.info("telegram bot started");
  await bot.launch();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
