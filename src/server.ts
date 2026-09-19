import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { webhookCallback } from 'grammy';
import type { AppBot } from './bot/index.js';
import { config } from './lib/config.js';
import { logger } from './lib/logger.js';
import { onShutdown } from './lib/shutdown.js';

/**
 * Секретный путь и заголовок для вебхука.
 * Выводим из токена, а не спрашиваем отдельной переменной: адрес вебхука
 * не должен угадываться, а лишняя обязательная настройка — лишний повод
 * уронить деплой. Токен и так самый секретный, что есть у бота.
 */
function webhookSecret(): string {
  return createHash('sha256').update(config.BOT_TOKEN).digest('hex').slice(0, 32);
}

export type Mode = 'webhook' | 'polling';

/**
 * Поднимает бота в том режиме, который следует из настроек.
 *
 * Вебхук — если задан WEBHOOK_URL. Иначе long polling; HTTP-сервер при этом
 * поднимается только ради healthcheck и только если платформа дала порт
 * (web service не стартует, пока никто не слушает порт).
 */
export async function startBot(bot: AppBot): Promise<Mode> {
  const secret = webhookSecret();

  if (config.WEBHOOK_URL) {
    const url = `${config.WEBHOOK_URL.replace(/\/$/, '')}/tg/${secret}`;
    await bot.api.setWebhook(url, {
      secret_token: secret,
      drop_pending_updates: true,
      allowed_updates: [],
    });

    const handle = webhookCallback(bot, 'http', { secretToken: secret });
    listen((req, res) => {
      if (req.url?.startsWith(`/tg/${secret}`)) return void handle(req, res);
      health(req, res);
    });

    logger.info({ url: url.replace(secret, '***') }, 'слушаем вебхук');
    return 'webhook';
  }

  // Оставшийся с прошлого запуска вебхук ломает getUpdates ошибкой 409,
  // поэтому перед polling его обязательно снимаем. Очередь при этом не
  // сбрасываем: написанное людьми за время деплоя должно дойти.
  await bot.api.deleteWebhook();

  if (config.PORT) listen(health);

  // bot.start() резолвится только после остановки, поэтому не ждём его здесь.
  void bot.start({
    onStart: (info) => logger.info({ bot: info.username }, 'слушаем обновления'),
  });

  return 'polling';
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): void {
  const port = config.PORT ?? 3000;
  const server = createServer(handler);

  server.listen(port, () => logger.info({ port }, 'http-сервер поднят'));
  onShutdown('http', () => new Promise<void>((resolve) => server.close(() => resolve())));
}

/** Пинг для платформы: она перезапускает сервис, если он перестал отвечать. */
function health(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, uptime: Math.round(process.uptime()) }));
    return;
  }

  res.writeHead(404);
  res.end();
}
