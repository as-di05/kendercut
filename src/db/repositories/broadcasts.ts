import { and, asc, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { broadcasts, subscriptions, users } from '../schema.js';

export type Broadcast = typeof broadcasts.$inferSelect;

/** Кому шлём. Сегмент хранится в jsonb-поле filter. */
export type Segment = 'all' | 'subscribers' | 'no_subscription';

export const SEGMENT_TITLES: Record<Segment, string> = {
  all: 'всем',
  subscribers: 'с подпиской',
  no_subscription: 'без подписки',
};

export const segmentOf = (broadcast: Broadcast): Segment => {
  const value = (broadcast.filter as { segment?: string }).segment;
  return value === 'subscribers' || value === 'no_subscription' ? value : 'all';
};

export async function createBroadcast(text: string, segment: Segment): Promise<Broadcast> {
  const [row] = await db
    .insert(broadcasts)
    .values({ text, filter: { segment }, status: 'draft' })
    .returning();
  return row!;
}

export async function getBroadcast(id: number): Promise<Broadcast | undefined> {
  const [row] = await db.select().from(broadcasts).where(eq(broadcasts.id, id)).limit(1);
  return row;
}

export async function listBroadcasts(limit = 10): Promise<Broadcast[]> {
  return db.select().from(broadcasts).orderBy(desc(broadcasts.id)).limit(limit);
}

export async function updateBroadcast(
  id: number,
  patch: Partial<typeof broadcasts.$inferInsert>,
): Promise<Broadcast | undefined> {
  const [row] = await db.update(broadcasts).set(patch).where(eq(broadcasts.id, id)).returning();
  return row;
}

export async function deleteBroadcast(id: number): Promise<void> {
  await db.delete(broadcasts).where(eq(broadcasts.id, id));
}

/** Рассылки, оборванные перезапуском. */
export async function listRunning(): Promise<Broadcast[]> {
  return db.select().from(broadcasts).where(eq(broadcasts.status, 'running'));
}

/** Активная подписка — та же проверка, что и в гварде доступа. */
const hasSubscription = sql`exists (
  select 1 from ${subscriptions}
  where ${subscriptions.userId} = ${users.tgId}
    and ${subscriptions.isActive}
    and ${subscriptions.expiresAt} > now()
)`;

const segmentFilter = (segment: Segment) => {
  if (segment === 'subscribers') return hasSubscription;
  if (segment === 'no_subscription') return sql`not ${hasSubscription}`;
  return undefined;
};

export async function countAudience(segment: Segment): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(users)
    .where(and(eq(users.isBanned, false), segmentFilter(segment)));

  return row?.n ?? 0;
}

/**
 * Очередная порция получателей.
 * Идём по возрастанию tg_id от курсора: так порядок не зависит от того,
 * кто в этот момент зашёл в бота, и рассылку можно продолжить после перезапуска.
 */
export async function audiencePage(
  segment: Segment,
  afterUserId: number | null,
  limit: number,
): Promise<{ tgId: number }[]> {
  return db
    .select({ tgId: users.tgId })
    .from(users)
    .where(
      and(
        eq(users.isBanned, false),
        afterUserId === null ? undefined : gt(users.tgId, afterUserId),
        segmentFilter(segment),
      ),
    )
    .orderBy(asc(users.tgId))
    .limit(limit);
}

/** Незавершённые черновики старше суток убираем, чтобы не копились. */
export async function dropStaleDrafts(): Promise<void> {
  await db
    .delete(broadcasts)
    .where(
      and(
        eq(broadcasts.status, 'draft'),
        isNull(broadcasts.finishedAt),
        sql`${broadcasts.createdAt} < now() - interval '1 day'`,
      ),
    );
}
