import { Composer } from 'grammy';
import { getUser } from '../../../db/repositories/users.js';
import { grantSubscription } from '../../../db/repositories/subscriptions.js';
import { formatDate, plural } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';

export const adminGrant = new Composer<BotContext>();

/**
 * Выдать подписку вручную: /grant [дней] [id пользователя]
 * Без аргументов — 30 дней себе. Нужно и для проверок до подключения оплаты,
 * и потом, чтобы решать вопросы поддержки.
 */
adminGrant.command('grant', async (ctx) => {
  const [daysRaw, userRaw] = (ctx.match ?? '').trim().split(/\s+/).filter(Boolean);

  const days = daysRaw ? Number(daysRaw) : 30;
  if (!Number.isInteger(days) || days <= 0 || days > 3650) {
    await ctx.reply('Формат: <code>/grant [дней] [id]</code>, например <code>/grant 7</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const targetId = userRaw ? Number(userRaw) : ctx.user.tgId;
  if (!Number.isSafeInteger(targetId)) {
    await ctx.reply('Некорректный id пользователя.');
    return;
  }

  if (!(await getUser(targetId))) {
    await ctx.reply('Такого пользователя нет в базе — он должен сначала запустить бота.');
    return;
  }

  const subscription = await grantSubscription({ userId: targetId, days, source: 'admin' });

  await ctx.reply(
    [
      `Выдал ${plural(days, 'день', 'дня', 'дней')} пользователю <code>${targetId}</code>.`,
      `Подписка активна до ${formatDate(subscription.expiresAt)}.`,
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});
