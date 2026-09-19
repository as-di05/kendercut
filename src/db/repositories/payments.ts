import { desc, eq } from 'drizzle-orm';
import { db } from '../index.js';
import { payments } from '../schema.js';
import type { Executor } from './subscriptions.js';

export type Payment = typeof payments.$inferSelect;

type PaidInput = {
  userId: number;
  planId: number;
  amount: number;
  currency: string;
  chargeId: string;
};

/**
 * Записывает состоявшийся платёж.
 * Возвращает undefined, если такой charge_id уже проведён: UNIQUE по нему —
 * и есть вся идемпотентность. Telegram повторяет апдейт, пока бот не ответит
 * 200, так что successful_payment вполне может прийти дважды.
 */
export async function insertPaidPayment(
  input: PaidInput,
  exec: Executor = db,
): Promise<Payment | undefined> {
  const [row] = await exec
    .insert(payments)
    .values({
      userId: input.userId,
      planId: input.planId,
      amount: input.amount,
      currency: input.currency,
      status: 'paid',
      telegramPaymentChargeId: input.chargeId,
    })
    .onConflictDoNothing({ target: payments.telegramPaymentChargeId })
    .returning();

  return row;
}

export async function getPaymentByChargeId(
  chargeId: string,
  exec: Executor = db,
): Promise<Payment | undefined> {
  const [row] = await exec
    .select()
    .from(payments)
    .where(eq(payments.telegramPaymentChargeId, chargeId))
    .limit(1);

  return row;
}

export async function attachSubscription(
  paymentId: number,
  subscriptionId: number,
  exec: Executor = db,
): Promise<void> {
  await exec.update(payments).set({ subscriptionId }).where(eq(payments.id, paymentId));
}

export async function markRefunded(paymentId: number, exec: Executor = db): Promise<void> {
  await exec.update(payments).set({ status: 'refunded' }).where(eq(payments.id, paymentId));
}

/** Последние платежи пользователя — для поддержки и возвратов. */
export async function listUserPayments(userId: number, limit = 10): Promise<Payment[]> {
  return db
    .select()
    .from(payments)
    .where(eq(payments.userId, userId))
    .orderBy(desc(payments.createdAt))
    .limit(limit);
}
