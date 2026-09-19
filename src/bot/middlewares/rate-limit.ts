import type { Middleware, NextFunction } from 'grammy';
import { logger } from '../../lib/logger.js';
import { key, redis } from '../../lib/redis.js';
import type { BotContext } from '../context.js';

type Options = {
  /** Сколько действий разрешено в окне. */
  limit?: number;
  /** Длина окна в секундах. */
  windowSec?: number;
};

/**
 * Ограничитель частоты на пользователя, счётчик в Redis.
 * Предупреждает один раз за окно, дальше молча отбрасывает апдейты:
 * если отвечать на каждый, при флуде бот сам себя загонит в лимиты Telegram.
 * Админы не ограничиваются.
 */
export function rateLimit({ limit = 20, windowSec = 10 }: Options = {}): Middleware<BotContext> {
  return async (ctx: BotContext, next: NextFunction) => {
    const userId = ctx.from?.id;
    if (!userId || ctx.isAdmin) return next();

    // Платёжные апдейты пропускаем всегда: pre_checkout_query Telegram ждёт
    // десять секунд, и молча отброшенный апдейт — это сорванная оплата.
    if (ctx.preCheckoutQuery || ctx.message?.successful_payment) return next();

    const k = key.rateLimit(userId);
    const count = await redis.incr(k);
    if (count === 1) await redis.expire(k, windowSec);

    if (count <= limit) return next();

    if (count === limit + 1) {
      logger.warn({ user: userId, count }, 'превышен лимит частоты');
      await ctx
        .reply('Слишком много запросов. Подождите несколько секунд.')
        .catch(() => undefined);
    }
    // Апдейт дальше не идёт.
  };
}
