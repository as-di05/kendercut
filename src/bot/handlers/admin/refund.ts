import { Composer } from 'grammy';
import { dashboard } from '../../../db/repositories/analytics.js';
import { listUserPayments } from '../../../db/repositories/payments.js';
import { formatDate } from '../../../lib/format.js';
import { refundPayment } from '../../../services/payments.js';
import type { BotContext } from '../../context.js';

export const adminRefund = new Composer<BotContext>();

/**
 * Баланс звёзд у самого бота.
 *
 * Звёзды, полученные ботом, лежат на его счёте, а не в личных «Моих звёздах»
 * владельца — это разные кошельки, и путать их естественно. Команда показывает
 * обе цифры сразу: сколько насчитал бот по своей базе и сколько на самом деле
 * держит Telegram.
 */
adminRefund.command('stars', async (ctx) => {
  const [balance, stats] = await Promise.all([
    ctx.api.getMyStarBalance().catch(() => undefined),
    dashboard(),
  ]);

  const lines = [
    '⭐ <b>Звёзды</b>',
    '',
    balance === undefined
      ? 'Баланс у Telegram запросить не удалось.'
      : `На счёте бота: <b>${balance.amount}</b> ⭐`,
    `Записано в базе: ${stats.starsTotal} ⭐ (за 30 дней ${stats.starsMonth} ⭐)`,
    '',
    'Это счёт бота, а не ваши личные «Мои звёзды» — там они не появятся.',
    'Вывод — через @BotFather, и только после того, как пройдёт срок',
    'на возвраты (21 день с оплаты) и наберётся минимальная сумма.',
  ];

  const recent = await ctx.api.getStarTransactions({ limit: 5 }).catch(() => undefined);
  if (recent && recent.transactions.length > 0) {
    lines.push('', '<b>Последние операции у Telegram:</b>');
    for (const tx of recent.transactions) {
      const sign = tx.source ? '+' : '−';
      lines.push(
        `${formatDate(new Date(tx.date * 1000))} · ${sign}${tx.amount} ⭐ · <code>${tx.id}</code>`,
      );
    }
  }

  await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
});

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
