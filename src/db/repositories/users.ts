import { eq, sql as raw } from 'drizzle-orm';
import { db } from '../index.js';
import { users } from '../schema.js';

export type User = typeof users.$inferSelect;

type UpsertInput = {
  tgId: number;
  username?: string | undefined;
  firstName?: string | undefined;
  /** Проставляется только при первом заходе — реферера потом не переписываем. */
  referrerId?: number | undefined;
};

/**
 * Заводит пользователя или обновляет его профиль.
 * Реферер пишется через COALESCE: первый, кто привёл, тот и остаётся.
 */
export async function upsertUser(input: UpsertInput): Promise<User> {
  const [user] = await db
    .insert(users)
    .values({
      tgId: input.tgId,
      username: input.username ?? null,
      firstName: input.firstName ?? null,
      referrerId: input.referrerId ?? null,
    })
    .onConflictDoUpdate({
      target: users.tgId,
      set: {
        username: raw.raw('excluded.username'),
        firstName: raw.raw('excluded.first_name'),
        referrerId: raw`coalesce(${users.referrerId}, excluded.referrer_id)`,
        lastSeenAt: new Date(),
      },
    })
    .returning();

  // returning() на upsert всегда отдаёт строку.
  return user!;
}

export async function getUser(tgId: number): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.tgId, tgId) });
}

export async function setBanned(tgId: number, isBanned: boolean): Promise<void> {
  await db.update(users).set({ isBanned }).where(eq(users.tgId, tgId));
}

export async function countUsers(): Promise<number> {
  const [row] = await db.select({ count: raw<number>`count(*)::int` }).from(users);
  return row?.count ?? 0;
}
