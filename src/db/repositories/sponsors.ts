import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { db } from '../index.js';
import { sponsorChannels, sponsorPasses } from '../schema.js';

export type SponsorChannel = typeof sponsorChannels.$inferSelect;

/**
 * Каналы, которые сейчас участвуют в гейте.
 * Канал без юзернейма и без инвайт-ссылки отбрасываем: подписаться на него
 * невозможно, а требовать подписку — значит запереть человека наглухо.
 */
export async function listActiveChannels(limit: number): Promise<SponsorChannel[]> {
  const now = new Date();
  return db
    .select()
    .from(sponsorChannels)
    .where(
      and(
        eq(sponsorChannels.isActive, true),
        or(isNull(sponsorChannels.startsAt), lte(sponsorChannels.startsAt, now)),
        or(isNull(sponsorChannels.endsAt), gt(sponsorChannels.endsAt, now)),
        or(isNotNull(sponsorChannels.username), isNotNull(sponsorChannels.inviteLink)),
      ),
    )
    .orderBy(asc(sponsorChannels.sort), asc(sponsorChannels.id))
    .limit(limit);
}

export async function listChannels(): Promise<SponsorChannel[]> {
  return db
    .select()
    .from(sponsorChannels)
    .orderBy(asc(sponsorChannels.sort), asc(sponsorChannels.id));
}

export async function countActiveChannels(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(sponsorChannels)
    .where(eq(sponsorChannels.isActive, true));
  return row?.n ?? 0;
}

export async function getChannel(id: number): Promise<SponsorChannel | undefined> {
  const [row] = await db.select().from(sponsorChannels).where(eq(sponsorChannels.id, id)).limit(1);
  return row;
}

export async function getChannelByChatId(chatId: number): Promise<SponsorChannel | undefined> {
  const [row] = await db
    .select()
    .from(sponsorChannels)
    .where(eq(sponsorChannels.chatId, chatId))
    .limit(1);
  return row;
}

type UpsertInput = {
  chatId: number;
  title: string;
  username?: string | undefined;
};

/**
 * Регистрирует канал при назначении бота администратором.
 * Новый канал заводится выключенным: включать его в гейт — решение админа,
 * а не того, кто добавил бота.
 */
export async function upsertChannel(
  input: UpsertInput,
): Promise<{ channel: SponsorChannel; isNew: boolean }> {
  const existing = await getChannelByChatId(input.chatId);

  if (existing) {
    const [updated] = await db
      .update(sponsorChannels)
      .set({ title: input.title, username: input.username ?? null })
      .where(eq(sponsorChannels.id, existing.id))
      .returning();
    return { channel: updated!, isNew: false };
  }

  const [created] = await db
    .insert(sponsorChannels)
    .values({
      chatId: input.chatId,
      title: input.title,
      username: input.username ?? null,
      isPrivate: input.username === undefined,
      isActive: false,
    })
    .returning();

  return { channel: created!, isNew: true };
}

export async function updateChannel(
  id: number,
  patch: Partial<typeof sponsorChannels.$inferInsert>,
): Promise<SponsorChannel | undefined> {
  const [row] = await db
    .update(sponsorChannels)
    .set(patch)
    .where(eq(sponsorChannels.id, id))
    .returning();
  return row;
}

export async function deleteChannel(id: number): Promise<void> {
  await db.delete(sponsorChannels).where(eq(sponsorChannels.id, id));
}

/**
 * Отмечает, что пользователь прошёл гейт по этим каналам.
 * Зачёт один на пару юзер-канал (UNIQUE), поэтому счётчик партнёра
 * показывает людей, а не клики: повторные проверки его не накручивают.
 */
export async function recordPasses(userId: number, channelIds: number[]): Promise<number> {
  if (channelIds.length === 0) return 0;

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(sponsorPasses)
      .values(channelIds.map((channelId) => ({ userId, channelId })))
      .onConflictDoNothing()
      .returning({ channelId: sponsorPasses.channelId });

    if (inserted.length === 0) return 0;

    await tx
      .update(sponsorChannels)
      .set({ joinedCount: sql`${sponsorChannels.joinedCount} + 1` })
      .where(
        inArray(
          sponsorChannels.id,
          inserted.map((row) => row.channelId),
        ),
      );

    return inserted.length;
  });
}
