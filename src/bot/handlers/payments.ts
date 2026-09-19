import { Composer, InlineKeyboard } from 'grammy';
import { getPlan } from '../../db/repositories/catalog.js';
import { formatDate } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import {
  applyPayment,
  buildPayload,
  checkPreCheckout,
  createSubscriptionLink,
  invoiceFor,
  STARS,
  supportsAutoRenew,
} from '../../services/payments.js';
import type { BotContext } from '../context.js';
import { nav } from '../keyboards/main.js';

export const paymentsHandler = new Composer<BotContext>();

// ── Разовый счёт ──────────────────────────────────────────────────────

paymentsHandler.callbackQuery(/^s:buy:(\d+)$/, async (ctx) => {
  const plan = await getPlan(Number(ctx.match[1]));
  if (!plan?.isActive) {
    await ctx.answerCallbackQuery({ text: 'Этот тариф больше не продаётся.', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  const { title, description, prices } = invoiceFor(plan);
  await ctx.replyWithInvoice(title, description, buildPayload(plan.id), STARS, prices);
});

// ── Автопродляемая подписка ───────────────────────────────────────────

paymentsHandler.callbackQuery(/^s:auto:(\d+)$/, async (ctx) => {
  const plan = await getPlan(Number(ctx.match[1]));
  if (!plan?.isActive || !supportsAutoRenew(plan)) {
    await ctx.answerCallbackQuery({ text: 'Этот тариф больше не продаётся.', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  let link: string;
  try {
    link = await createSubscriptionLink(ctx.api, plan);
  } catch (err) {
    // Автосписание может быть недоступно этому боту. Не оставлять же человека
    // без возможности заплатить — выставляем обычный счёт.
    logger.error({ err, plan: plan.code }, 'не удалось создать подписочную ссылку');
    const { title, description, prices } = invoiceFor(plan);
    await ctx.replyWithInvoice(title, description, buildPayload(plan.id), STARS, prices);
    return;
  }

  await ctx.reply(
    [
      `🔄 <b>${plan.title} с автопродлением</b>`,
      '',
      `${plan.priceStars} ⭐ раз в 30 дней. Отменить можно в любой момент —`,
      'Telegram → Настройки → Мои звёзды → Подписки.',
    ].join('\n'),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().url(`Оформить за ${plan.priceStars} ⭐`, link),
    },
  );
});

// ── Подтверждение перед списанием ─────────────────────────────────────

/**
 * Telegram ждёт ответ 10 секунд и при опоздании отменяет платёж,
 * поэтому здесь только одна проверка и никакой тяжёлой работы.
 */
paymentsHandler.on('pre_checkout_query', async (ctx) => {
  try {
    const verdict = await checkPreCheckout(ctx.preCheckoutQuery.invoice_payload);
    await ctx.answerPreCheckoutQuery(
      verdict.ok,
      verdict.ok ? undefined : { error_message: verdict.message },
    );
  } catch (err) {
    logger.error({ err }, 'не удалось проверить pre_checkout_query');
    await ctx
      .answerPreCheckoutQuery(false, {
        error_message: 'Не получилось подтвердить оплату. Попробуйте ещё раз.',
      })
      .catch(() => undefined);
  }
});

// ── Деньги пришли ─────────────────────────────────────────────────────

paymentsHandler.on('message:successful_payment', async (ctx) => {
  const paid = ctx.message.successful_payment;

  const outcome = await applyPayment({
    userId: ctx.from.id,
    chargeId: paid.telegram_payment_charge_id,
    amount: paid.total_amount,
    currency: paid.currency,
    payload: paid.invoice_payload,
    isRecurring: paid.is_recurring === true,
  });

  if (outcome.status === 'unknown_plan') {
    await ctx.reply(
      'Оплата прошла, но тариф не распознан. Напишите администратору — разберёмся и вернём звёзды.',
    );
    return;
  }

  if (outcome.status === 'duplicate') {
    // Тот же платёж уже проведён: Telegram повторил апдейт. Молчать нельзя —
    // человек видит списание и ждёт подтверждения.
    await ctx.reply('Эта оплата уже учтена, подписка активна.');
    return;
  }

  const renewal = paid.is_recurring === true && paid.is_first_recurring !== true;
  const lines = [
    renewal ? '🔄 <b>Подписка продлена</b>' : '⭐ <b>Оплата прошла</b>',
    '',
    `Доступ открыт до ${formatDate(outcome.expiresAt)}.`,
  ];

  if (paid.is_recurring === true) {
    lines.push('', 'Продление списывается автоматически. Отменить: Настройки → Мои звёзды.');
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('🎬 В каталог', nav.catalog),
  });
});
