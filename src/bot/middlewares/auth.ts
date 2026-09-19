import type { Middleware, NextFunction } from 'grammy';
import { isAdmin } from '../../lib/config.js';
import { logger } from '../../lib/logger.js';
import { upsertUser } from '../../db/repositories/users.js';
import type { BotContext } from '../context.js';

/**
 * Заводит пользователя в БД и кладёт его в контекст.
 * Забаненных дальше не пускает — молча, чтобы не давать обратной связи.
 */
export function auth(): Middleware<BotContext> {
  return async (ctx: BotContext, next: NextFunction) => {
    const from = ctx.from;
    // Посты в канале-хранилище и прочие апдеты без отправителя — мимо.
    if (!from || from.is_bot) return next();

    ctx.user = await upsertUser({
      tgId: from.id,
      username: from.username,
      firstName: from.first_name,
      referrerId: extractReferrer(ctx),
    });
    ctx.isAdmin = isAdmin(from.id);

    if (ctx.user.isBanned) {
      logger.debug({ user: from.id }, 'забаненный пользователь, апдейт проигнорирован');
      return;
    }

    return next();
  };
}

/**
 * Реферер из диплинка /start ref_<id>.
 * Записывается только при первом заходе — за это отвечает coalesce в upsertUser.
 */
function extractReferrer(ctx: BotContext): number | undefined {
  const text = ctx.message?.text;
  if (!text?.startsWith('/start ')) return undefined;

  const payload = text.slice('/start '.length).trim();
  if (!payload.startsWith('ref_')) return undefined;

  const id = Number(payload.slice('ref_'.length));
  // Сам себя пригласить нельзя.
  if (!Number.isSafeInteger(id) || id <= 0 || id === ctx.from?.id) return undefined;

  return id;
}
