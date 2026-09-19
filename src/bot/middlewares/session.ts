import { RedisAdapter } from '@grammyjs/storage-redis';
import { session } from 'grammy';
import type { Middleware } from 'grammy';
import { key, redis } from '../../lib/redis.js';
import type { BotContext, SessionData } from '../context.js';
import { initialSession } from '../context.js';

export function sessionMiddleware(): Middleware<BotContext> {
  return session<SessionData, BotContext>({
    initial: initialSession,
    // Ключ по пользователю, а не по чату: состояние должно жить и в личке, и в инлайне.
    getSessionKey: (ctx) => (ctx.from ? key.session(String(ctx.from.id)) : undefined),
    storage: new RedisAdapter({ instance: redis, ttl: 60 * 60 * 24 }),
  });
}
