import { Composer } from 'grammy';
import { listUserPayments } from '../../../db/repositories/payments.js';
import { formatDate } from '../../../lib/format.js';
import { refundPayment } from '../../../services/payments.js';
import type { BotContext } from '../../context.js';

export const adminRefund = new Composer<BotContext>();

/** Последние платежи пользователя — отсюда берут charge_id для возврата. */
adminRefund.command('payments', async (ctx) => {
  const raw = (ctx.match ?? '').trim();
  const userId = raw ? Number(raw) : ctx.user.tgId;

  if (!Number.isSafeInteger(userId)) {
    await ctx.reply('Формат: <code>/payments [id]</code>', { parse_mode: 'HTML' });
    return;
  }

  const rows = await listUserPayments(userId);
  if (rows.length === 0) {
    await ctx.reply('Платежей нет.');
    return;
  }

  const lines = rows.map(
    (p) =>
      `${formatDate(p.createdAt)} · ${p.amount} ${p.currency} · ${p.status}\n` +
      `<code>${p.telegramPaymentChargeId ?? '—'}</code>`,
  );

  await ctx.reply([`Платежи <code>${userId}</code>:`, '', ...lines].join('\n'), {
    parse_mode: 'HTML',
  });
});

/**
 * Возврат звёзд: /refund <charge_id>
 * Telegram разрешает вернуть платёж в течение 21 дня; вместе с деньгами
 * забираем и оплаченные дни, иначе подписка останется бесплатной.
 */
adminRefund.command('refund', async (ctx) => {
  const chargeId = (ctx.match ?? '').trim();
  if (!chargeId) {
    await ctx.reply('Формат: <code>/refund &lt;charge_id&gt;</code>, список — <code>/payments</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

  const outcome = await refundPayment(ctx.api, chargeId);

  switch (outcome.status) {
    case 'refunded':
      await ctx.reply(
        `Вернул ${outcome.amount} ⭐ пользователю <code>${outcome.userId}</code>, дни сняты.`,
        { parse_mode: 'HTML' },
      );
      await ctx.api
        .sendMessage(
          outcome.userId,
          `Оплата возвращена: ${outcome.amount} ⭐ придут обратно на баланс. Подписка снята.`,
        )
        .catch(() => undefined);
      return;
    case 'not_found':
      await ctx.reply('Платёж с таким charge_id не найден.');
      return;
    case 'already_refunded':
      await ctx.reply('Этот платёж уже возвращён.');
      return;
    case 'failed':
      await ctx.reply(`Telegram отказал: ${outcome.message}`);
      return;
  }
});
