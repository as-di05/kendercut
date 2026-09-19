import { desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../index.js';
import {
  films,
  payments,
  referrals,
  searchQueries,
  sponsorPasses,
  subscriptions,
  users,
  views,
} from '../schema.js';

/**
 * Пишем каждый поисковый запрос, включая пустые.
 * Нулевые результаты — это и есть список того, что стоит залить следующим.
 */
export async function logSearch(
  userId: number | undefined,
  query: string,
  resultsCount: number,
): Promise<void> {
  await db.insert(searchQueries).values({
    userId: userId ?? null,
    query: query.slice(0, 200),
    resultsCount,
  });
}

export type Dashboard = {
  users: number;
  newToday: number;
  dau: number;
  activeSubs: number;
  starsTotal: number;
  starsMonth: number;
  viewsToday: number;
  gatePasses: number;
  referralsPaid: number;
};

/** Сводка для админки. Один запрос — числа должны быть на один момент времени. */
export async function dashboard(): Promise<Dashboard> {
  const [row] = await db.execute<Dashboard>(sql`
    select
      (select count(*)::int from ${users}) as users,
      (select count(*)::int from ${users} where ${users.createdAt} >= now() - interval '1 day') as "newToday",
      (select count(*)::int from ${users} where ${users.lastSeenAt} >= now() - interval '1 day') as dau,
      (select count(*)::int from ${subscriptions}
        where ${subscriptions.isActive} and ${subscriptions.expiresAt} > now()) as "activeSubs",
      (select coalesce(sum(${payments.amount}), 0)::int from ${payments}
        where ${payments.status} = 'paid') as "starsTotal",
      (select coalesce(sum(${payments.amount}), 0)::int from ${payments}
        where ${payments.status} = 'paid' and ${payments.createdAt} >= now() - interval '30 days') as "starsMonth",
      (select count(*)::int from ${views} where ${views.createdAt} >= now() - interval '1 day') as "viewsToday",
      (select count(*)::int from ${sponsorPasses}) as "gatePasses",
      (select count(*)::int from ${referrals} where ${referrals.bonusDays} > 0) as "referralsPaid"
  `);

  return row!;
}

export type TopFilm = { id: number; titleRu: string; views: number };

export async function topFilms(days: number, limit = 10): Promise<TopFilm[]> {
  const since = new Date(Date.now() - days * 86_400_000);

  return db
    .select({
      id: films.id,
      titleRu: films.titleRu,
      views: sql<number>`count(*)::int`,
    })
    .from(views)
    .innerJoin(films, eq(films.id, views.filmId))
    .where(gte(views.createdAt, since))
    .groupBy(films.id, films.titleRu)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}

export type MissedQuery = { query: string; times: number };

/** Что искали и не нашли — список того, что стоит залить следующим. */
export async function missedQueries(limit = 20): Promise<MissedQuery[]> {
  return db
    .select({ query: searchQueries.query, times: sql<number>`count(*)::int` })
    .from(searchQueries)
    .where(eq(searchQueries.resultsCount, 0))
    .groupBy(searchQueries.query)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);
}
