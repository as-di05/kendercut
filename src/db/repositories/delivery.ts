import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { deliveredMessages, views } from '../schema.js';

export type DeliveredMessage = typeof deliveredMessages.$inferSelect;

export async function recordView(userId: number, filmId: number): Promise<void> {
  await db.insert(views).values({ userId, filmId });
}

/** Ставит выданное сообщение в очередь на автоудаление. */
export async function scheduleDeletion(
  userId: number,
  chatId: number,
  messageId: number,
  deleteAt: Date,
): Promise<void> {
  await db.insert(deliveredMessages).values({ userId, chatId, messageId, deleteAt });
}

/** Сообщения, которым пора исчезнуть. */
export async function listDueDeletions(limit = 100): Promise<DeliveredMessage[]> {
  return db
    .select()
    .from(deliveredMessages)
    .where(and(isNull(deliveredMessages.deletedAt), lte(deliveredMessages.deleteAt, new Date())))
    .orderBy(asc(deliveredMessages.deleteAt))
    .limit(limit);
}

export async function markDeleted(id: number): Promise<void> {
  await db.update(deliveredMessages).set({ deletedAt: new Date() }).where(eq(deliveredMessages.id, id));
}

/**
 * Сколько фильмов пользователь получил за последние сутки.
 * Окно скользящее, а не «с полуночи»: так не бывает всплеска в 00:01
 * и не нужно решать, чья это полночь.
 */
export async function countViewsSince(userId: number, since: Date): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(views)
    .where(and(eq(views.userId, userId), gte(views.createdAt, since)));

  return row?.n ?? 0;
}
