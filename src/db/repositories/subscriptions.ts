import { and, desc, eq, gt, lte } from 'drizzle-orm';
import { db } from '../index.js';
import { subscriptions } from '../schema.js';

export type Subscription = typeof subscriptions.$inferSelect;

/** Транзакция Drizzle — тот же интерфейс запросов, что и у db. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = typeof db | Tx;

/** Действующая подписка пользователя — та, что кончается позже всех. */
export async function getActiveSubscription(
  userId: number,
  exec: Executor = db,
): Promise<Subscription | undefined> {
  const [row] = await exec
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        eq(subscriptions.isActive, true),
        gt(subscriptions.expiresAt, new Date()),
      ),
    )
    .orderBy(desc(subscriptions.expiresAt))
    .limit(1);

  return row;
}

export async function hasActiveSubscription(userId: number): Promise<boolean> {
  return (await getActiveSubscription(userId)) !== undefined;
}

type GrantInput = {
  userId: number;
  days: number;
  planId?: number | undefined;
  source: (typeof subscriptions.$inferInsert)['source'];
  /** Подписка Telegram с автосписанием — о конце срока напоминать не нужно. */
  autoRenew?: boolean | undefined;
};

/**
 * Выдаёт или продлевает подписку.
 * Если действующая ещё не кончилась, новый срок прибавляется к её концу,
 * а не к сегодняшнему дню: оплативший заранее не теряет остаток.
 */
export async function grantSubscription(
  input: GrantInput,
  exec?: Executor,
): Promise<Subscription> {
  // Если нас позвали изнутри чужой транзакции, свою не открываем.
  if (exec) return grantWithin(exec, input);
  return db.transaction((tx) => grantWithin(tx, input));
}

async function grantWithin(exec: Executor, input: GrantInput): Promise<Subscription> {
  const current = await getActiveSubscription(input.userId, exec);
  const startsAt = current?.expiresAt ?? new Date();
  const expiresAt = new Date(startsAt.getTime() + input.days * 86_400_000);

  // Одна активная подписка на пользователя: прежние закрываем.
  await exec
    .update(subscriptions)
    .set({ isActive: false })
    .where(and(eq(subscriptions.userId, input.userId), eq(subscriptions.isActive, true)));

  const [created] = await exec
    .insert(subscriptions)
    .values({
      userId: input.userId,
      planId: input.planId ?? null,
      source: input.source,
      startsAt,
      expiresAt,
      isActive: true,
      autoRenew: input.autoRenew ?? false,
    })
    .returning();

  return created!;
}

/**
 * Откатывает подписку на N дней назад — после возврата платежа.
 * Если после отката срок уже вышел, подписка снимается совсем.
 */
export async function revokeDays(
  subscriptionId: number,
  days: number,
  exec: Executor = db,
): Promise<Subscription | undefined> {
  const [current] = await exec
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId))
    .limit(1);

  if (!current) return undefined;

  const expiresAt = new Date(current.expiresAt.getTime() - days * 86_400_000);
  const [updated] = await exec
    .update(subscriptions)
    .set({ expiresAt, isActive: expiresAt.getTime() > Date.now() && current.isActive })
    .where(eq(subscriptions.id, subscriptionId))
    .returning();

  return updated;
}

/**
 * Закрывает подписки, у которых вышел срок.
 * Доступ они не дают и так — `getActiveSubscription` смотрит на `expires_at`, —
 * но флаг надо снять, иначе счётчики и рассылки будут врать. Возвращаем
 * закрытые, чтобы сообщить людям.
 */
export async function expireSubscriptions(): Promise<Subscription[]> {
  return db
    .update(subscriptions)
    .set({ isActive: false })
    .where(and(eq(subscriptions.isActive, true), lte(subscriptions.expiresAt, new Date())))
    .returning();
}

/**
 * Подписки, которые кончаются в ближайшие `days` суток.
 * Какое напоминание уже отправлено, решает сама задача — здесь только выборка.
 * Автопродляемые пропускаем: Telegram сам предупреждает о списании,
 * а наше письмо только пугало бы.
 */
export async function listExpiringSoon(days: number): Promise<Subscription[]> {
  const now = new Date();
  const until = new Date(now.getTime() + days * 86_400_000);

  return db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.isActive, true),
        eq(subscriptions.autoRenew, false),
        gt(subscriptions.expiresAt, now),
        lte(subscriptions.expiresAt, until),
      ),
    );
}

export async function markReminded(id: number, days: number): Promise<void> {
  await db.update(subscriptions).set({ lastReminderDays: days }).where(eq(subscriptions.id, id));
}
