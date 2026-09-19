import type { Api } from 'grammy';
import { db } from '../db/index.js';
import type { Plan } from '../db/repositories/catalog.js';
import {
  attachSubscription,
  getPaymentByChargeId,
  insertPaidPayment,
  markRefunded,
} from '../db/repositories/payments.js';
import { grantSubscription, revokeDays } from '../db/repositories/subscriptions.js';
import { getPlan } from '../db/repositories/catalog.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { plural } from '../lib/format.js';

/** Оплата звёздами — валюта XTR, суммы целые. */
export const STARS = 'XTR';

/**
 * Единственный период, который Telegram разрешает для автопродления, — 30 суток.
 * Любое другое значение subscription_period Bot API отклоняет.
 */
export const SUBSCRIPTION_PERIOD_SEC = 2_592_000;
const SUBSCRIPTION_DAYS = 30;

/** Можно ли продавать этот тариф как автопродляемую подписку. */
export function supportsAutoRenew(plan: Plan): boolean {
  return config.STARS_AUTO_RENEW && plan.days === SUBSCRIPTION_DAYS;
}

/**
 * Что кладём в invoice_payload. Вернётся к нам в pre_checkout_query и в
 * successful_payment — больше никакого способа связать платёж с тарифом нет.
 */
export const buildPayload = (planId: number): string => `sub:${planId}`;

export function parsePayload(payload: string): number | undefined {
  const [kind, raw] = payload.split(':');
  if (kind !== 'sub') return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Заголовок, описание и цена — одинаковые и для разового счёта, и для подписки. */
export function invoiceFor(plan: Plan): {
  title: string;
  description: string;
  prices: [{ label: string; amount: number }];
} {
  return {
    title: `Подписка — ${plan.title}`,
    description: `Полный доступ к каталогу на ${plural(plan.days, 'день', 'дня', 'дней')}.`,
    prices: [{ label: plan.title, amount: plan.priceStars }],
  };
}

/**
 * Ссылка на автопродляемую подписку.
 * Счёт с subscription_period можно выпустить только через createInvoiceLink —
 * у sendInvoice такого параметра нет.
 */
export async function createSubscriptionLink(api: Api, plan: Plan): Promise<string> {
  const { title, description, prices } = invoiceFor(plan);
  return api.createInvoiceLink(title, description, buildPayload(plan.id), '', STARS, prices, {
    subscription_period: SUBSCRIPTION_PERIOD_SEC,
  });
}

export type PreCheckout = { ok: true; plan: Plan } | { ok: false; message: string };

/**
 * Проверка перед списанием. Ответить нужно за 10 секунд, иначе Telegram
 * сам отменит платёж, поэтому здесь только один запрос в базу.
 */
export async function checkPreCheckout(payload: string): Promise<PreCheckout> {
  const planId = parsePayload(payload);
  const plan = planId === undefined ? undefined : await getPlan(planId);

  if (!plan) return { ok: false, message: 'Тариф не найден. Откройте «Подписка» заново.' };
  if (!plan.isActive) return { ok: false, message: 'Этот тариф больше не продаётся.' };

  return { ok: true, plan };
}

export type PaymentOutcome =
  | { status: 'granted'; days: number; expiresAt: Date }
  | { status: 'duplicate' }
  | { status: 'unknown_plan' };

type ApplyInput = {
  userId: number;
  chargeId: string;
  amount: number;
  currency: string;
  payload: string;
  /** Платёж по подписке Telegram с автосписанием. */
  isRecurring?: boolean | undefined;
};

/**
 * Проводит оплату: запись платежа и продление подписки в одной транзакции.
 * Повторный апдейт с тем же charge_id ничего не продлит — на нём UNIQUE.
 */
export async function applyPayment(input: ApplyInput): Promise<PaymentOutcome> {
  const planId = parsePayload(input.payload);
  const plan = planId === undefined ? undefined : await getPlan(planId);

  if (!plan) {
    logger.error({ payload: input.payload, charge: input.chargeId }, 'оплата по неизвестному тарифу');
    return { status: 'unknown_plan' };
  }

  return db.transaction(async (tx) => {
    const payment = await insertPaidPayment(
      {
        userId: input.userId,
        planId: plan.id,
        amount: input.amount,
        currency: input.currency,
        chargeId: input.chargeId,
      },
      tx,
    );

    if (!payment) {
      logger.info({ charge: input.chargeId }, 'повторный successful_payment, пропущен');
      return { status: 'duplicate' };
    }

    const subscription = await grantSubscription(
      {
        userId: input.userId,
        days: plan.days,
        planId: plan.id,
        source: 'payment',
        autoRenew: input.isRecurring ?? false,
      },
      tx,
    );
    await attachSubscription(payment.id, subscription.id, tx);

    logger.info(
      { user: input.userId, plan: plan.code, stars: input.amount },
      'подписка оплачена звёздами',
    );

    return { status: 'granted', days: plan.days, expiresAt: subscription.expiresAt };
  });
}

export type RefundOutcome =
  | { status: 'refunded'; userId: number; amount: number }
  | { status: 'not_found' }
  | { status: 'already_refunded' }
  | { status: 'failed'; message: string };

/**
 * Возврат звёзд. Сначала просим Telegram вернуть деньги и только потом
 * правим базу: если запрос не прошёл, у пользователя не должно остаться
 * ни снятой подписки, ни пометки о возврате.
 */
export async function refundPayment(api: Api, chargeId: string): Promise<RefundOutcome> {
  const payment = await getPaymentByChargeId(chargeId);
  if (!payment) return { status: 'not_found' };
  if (payment.status === 'refunded') return { status: 'already_refunded' };

  try {
    await api.refundStarPayment(payment.userId, chargeId);
  } catch (err) {
    logger.error({ err, charge: chargeId }, 'Telegram отказал в возврате');
    return { status: 'failed', message: err instanceof Error ? err.message : 'неизвестная ошибка' };
  }

  const plan = payment.planId === null ? undefined : await getPlan(payment.planId);

  await db.transaction(async (tx) => {
    await markRefunded(payment.id, tx);
    // Деньги вернули — забираем и дни, иначе подписка останется бесплатной.
    if (payment.subscriptionId !== null && plan) {
      await revokeDays(payment.subscriptionId, plan.days, tx);
    }
  });

  logger.warn({ user: payment.userId, charge: chargeId }, 'платёж возвращён');
  return { status: 'refunded', userId: payment.userId, amount: payment.amount };
}
