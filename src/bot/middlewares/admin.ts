import type { Middleware, NextFunction } from 'grammy';
import type { BotContext } from '../context.js';

/** Пускает дальше только админов из ADMIN_IDS. Вешается на админскую композицию. */
export function requireAdmin(): Middleware<BotContext> {
  return async (ctx: BotContext, next: NextFunction) => {
    if (!ctx.isAdmin) {
      // Не «доступ запрещён», а тишина: посторонним незачем знать, что раздел есть.
      await ctx.answerCallbackQuery?.().catch(() => undefined);
      return;
    }
    return next();
  };
}
