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
      // Сбрасываем всё, к чему привязан незавершённый ввод. Забытый здесь
      // editChannelId приводил бы к тому, что следующий текст админа улетает
      // в поле канала, из которого он давно ушёл.
      ctx.session.awaiting = undefined;
      ctx.session.draftFilmId = undefined;
      ctx.session.editPlanId = undefined;
      ctx.session.editChannelId = undefined;
      ctx.session.broadcastSegment = undefined;
    }
    return next();
  };
}
