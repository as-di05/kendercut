import { GrammyError } from 'grammy';
import { createBot, setCommands } from './bot/index.js';
import { applyMigrations, seedDefaults } from './db/bootstrap.js';
import { assertDbReachable } from './db/index.js';
import { startJobs } from './jobs/index.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { alertAdmins, useApiForAlerts } from './lib/alerts.js';
import { connectRedis } from './lib/redis.js';
import { startBot } from './server.js';
import { installShutdownHandlers, onShutdown } from './lib/shutdown.js';

async function main(): Promise<void> {
  installShutdownHandlers({
    onFatal: (reason, err) =>
      alertAdmins(
        ['💥 <b>Бот падает</b>', '', reason, String(err).slice(0, 500)].join('\n'),
        reason,
      ),
  });

  // Лучше упасть на старте, чем отдать пользователю ошибку на первом же запросе.
  await connectOrDie('Postgres', 'DATABASE_URL', assertDbReachable);
  await connectOrDie('Redis', 'REDIS_URL', connectRedis);

  // Схема и справочники поднимаются сами: на чистой базе первый запуск
  // не требует ручных команд, а на существующей оба шага ничего не меняют.
  await connectOrDie('схемой базы', 'DATABASE_URL', async () => {
    await applyMigrations();
    await seedDefaults();
  });

  const bot = createBot();
  useApiForAlerts(bot.api);
  onShutdown('bot', () => bot.stop());

  try {
    await bot.init();
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 401) {
      logger.fatal('Telegram отклонил BOT_TOKEN (401). Проверьте токен в .env — его выдаёт @BotFather');
    } else {
      logger.fatal({ err }, 'не удалось связаться с Telegram при старте');
    }
    process.exit(1);
  }

  await setCommands(bot);
  startJobs(bot.api);

  const mode = await startBot(bot);

  logger.info(
    {
      bot: bot.botInfo.username,
      mode,
      env: config.NODE_ENV,
      admins: config.ADMIN_IDS.length,
    },
    'бот запущен',
  );
}

async function connectOrDie(name: string, envVar: string, connect: () => Promise<void>) {
  try {
    await connect();
  } catch (err) {
    logger.fatal({ err }, `не разобрались с ${name} — проверьте ${envVar} и что сервер запущен`);
    process.exit(1);
  }
}

void main();
