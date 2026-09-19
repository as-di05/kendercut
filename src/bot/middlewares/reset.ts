import type { Middleware, NextFunction } from 'grammy';
import type { BotContext } from '../context.js';

/**
 * Любая команда прерывает незавершённый ввод.
 * Без этого админ, начавший вводить год и передумавший, застревал бы:
 * /start обрабатывается раньше мастера и состояние не сбрасывал.
 */
export function resetOnCommand(): Middleware<BotContext> {
  return async (ctx: BotContext, next: NextFunction) => {
    if (!ctx.from) return next();

    if (ctx.message?.text?.startsWith('/') && ctx.session.awaiting) {
      ctx.session.awaiting = undefined;
      ctx.session.draftFilmId = undefined;
    }
    return next();
  };
}
