import { and, eq, gte, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { referrals } from '../schema.js';
import type { Executor } from './subscriptions.js';

export type Referral = typeof referrals.$inferSelect;

/**
 * Записывает приглашение. Возвращает undefined, если этого человека уже
 * засчитали: на `invited_id` стоит UNIQUE, и это вся защита от повторов —
 * один приглашённый приносит бонус ровно один раз, сколько бы фильмов
 * он потом ни посмотрел.
 */
export async function createReferral(
  input: { inviterId: number; invitedId: number; bonusDays: number },
  exec: Executor = db,
): Promise<Referral | undefined> {
  const [row] = await exec
    .insert(referrals)
    .values(input)
    .onConflictDoNothing({ target: referrals.invitedId })
    .returning();

  return row;
}

export async function hasReferral(invitedId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: referrals.id })
    .from(referrals)
    .where(eq(referrals.invitedId, invitedId))
    .limit(1);

  return row !== undefined;
}

export type ReferralStats = {
  /** Сколько приглашённых дошло до просмотра. */
  invited: number;
  /** Из них те, за кого начислены дни. */
  credited: number;
  days: number;
};

export async function referralStats(inviterId: number): Promise<ReferralStats> {
  const [row] = await db
    .select({
      invited: sql<number>`count(*)::int`,
      credited: sql<number>`count(*) filter (where ${referrals.bonusDays} > 0)::int`,
      days: sql<number>`coalesce(sum(${referrals.bonusDays}), 0)::int`,
    })
    .from(referrals)
    .where(eq(referrals.inviterId, inviterId));

  return row ?? { invited: 0, credited: 0, days: 0 };
}

/** Сколько приглашений уже оплачено этому человеку за период — для дневного лимита. */
export async function countCreditedSince(inviterId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(referrals)
    .where(
      and(
        eq(referrals.inviterId, inviterId),
        gte(referrals.createdAt, since),
        sql`${referrals.bonusDays} > 0`,
      ),
    );

  return row?.n ?? 0;
}
