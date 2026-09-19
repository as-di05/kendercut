import { autoRetry } from '@grammyjs/auto-retry';
import { Bot, GrammyError, HttpError } from 'grammy';
import { alertAdmins } from '../lib/alerts.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { BotContext } from './context.js';
import { adminHandler } from './handlers/admin/index.js';
import { catalogHandler } from './handlers/catalog.js';
import { channelHandler } from './handlers/channel.js';
import { inviteHandler } from './handlers/invite.js';
import { menuHandler } from './handlers/menu.js';
import { paymentsHandler } from './handlers/payments.js';
import { registerPing } from './handlers/ping.js';
import { searchHandler } from './handlers/search.js';
import { sponsorHandler } from './handlers/sponsor.js';
import { startHandler } from './handlers/start.js';
import { subscriptionHandler } from './handlers/subscription.js';
import { auth } from './middlewares/auth.js';
import { rateLimit } from './middlewares/rate-limit.js';
import { resetOnCommand } from './middlewares/reset.js';
import { sessionMiddleware } from './middlewares/session.js';

export type AppBot = Bot<BotContext>;

export function createBot(): AppBot {
  const bot = new Bot<BotContext>(config.BOT_TOKEN);

  // Сам переживает 429 Too Many Requests и ждёт retry_after вместо падения.
  bot.api.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 10 }));

  bot.use(requestLogger());

  // Посты из канала-хранилища идут до сессии и авторизации: у них нет
  // отправителя-человека, а значит ни сессии, ни профиля для них не существует.
  bot.use(channelHandler);

  // Порядок важен: сессия и профиль нужны лимитеру (админов он пропускает).
  bot.use(sessionMiddleware());
  bot.use(auth());
  bot.use(rateLimit());
  bot.use(resetOnCommand());

  bot.use(startHandler);
  bot.use(adminHandler);
  bot.use(catalogHandler);
  bot.use(subscriptionHandler);
  bot.use(paymentsHandler);
  bot.use(sponsorHandler);
  bot.use(inviteHandler);
  bot.use(menuHandler);
  // Поиск последний: он подхватывает любой текст, не разобранный выше.
  bot.use(searchHandler);
  registerPing(bot);

  // Нажатие на кнопку, обработчика для которой не нашлось: обычно это старое
  // сообщение после перезапуска. Молчащая кнопка выглядит как поломка.
  bot.on('callback_query:data', async (ctx) => {
    logger.debug({ data: ctx.callbackQuery.data }, 'неизвестный callback');
    await ctx.answerCallbackQuery({ text: 'Кнопка устарела, откройте /start', show_alert: false });
  });

  bot.catch((err) => {
    const ctx = err.ctx;
    const base = { update: ctx.update.update_id, from: ctx.from?.id };

    if (err.error instanceof GrammyError) {
      logger.error({ ...base, description: err.error.description }, 'ошибка Telegram API');
    } else if (err.error instanceof HttpError) {
      logger.error({ ...base, err: err.error }, 'не удалось связаться с Telegram');
    } else {
      logger.error({ ...base, err: err.error }, 'необработанная ошибка');
      // Ошибки Telegram и сети бывают у всех, а вот своя — это баг,
      // и о нём лучше узнать сразу, а не из жалоб.
      const message = err.error instanceof Error ? err.error.message : String(err.error);
      void alertAdmins(
        ['⚠️ <b>Ошибка в боте</b>', '', message.slice(0, 500)].join('\n'),
        message,
      );
    }
  });

  return bot;
}

function requestLogger() {
  return async (ctx: BotContext, next: () => Promise<void>) => {
    const started = Date.now();
    await next();
    logger.debug(
      { update: ctx.update.update_id, from: ctx.from?.id, ms: Date.now() - started },
      'update обработан',
    );
  };
}

/** Список команд в меню Telegram. */
export async function setCommands(bot: AppBot): Promise<void> {
  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'ping', description: 'Проверить, жив ли бот' },
  ]);

  // Админские команды видны только администраторам.
  for (const adminId of config.ADMIN_IDS) {
    await bot.api
      .setMyCommands(
        [
          { command: 'start', description: 'Главное меню' },
          { command: 'ping', description: 'Проверить, жив ли бот' },
          { command: 'grant', description: 'Выдать подписку: /grant [дней] [id]' },
          { command: 'payments', description: 'Платежи пользователя: /payments [id]' },
          { command: 'refund', description: 'Вернуть звёзды: /refund <charge_id>' },
          { command: 'user', description: 'Карточка пользователя: /user <id>' },
          { command: 'stars', description: 'Баланс звёзд бота' },
        ],
        { scope: { type: 'chat', chat_id: adminId } },
      )
      .catch(() => undefined);
  }
}
