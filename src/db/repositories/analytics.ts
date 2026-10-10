import { desc, eq, gte, sql } from 'drizzle-orm';
import { db } from '../index.js';
import {
  films,
  payments,
  referrals,
  searchQueries,
  sponsorPasses,
  subscriptions,
  userDays,
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

export type UserTotals = {
  /** Сколько уникальных людей вообще запускали бота. */
  total: number;
  activeDay: number;
  activeWeek: number;
  activeMonth: number;
  withSubscription: number;
  banned: number;
};

export async function userTotals(): Promise<UserTotals> {
  const [row] = await db.execute<UserTotals>(sql`
    select
      (select count(*)::int from ${users}) as total,
      (select count(distinct ${userDays.userId})::int from ${userDays}
        where ${userDays.day} >= (now() at time zone 'Europe/Moscow')::date) as "activeDay",
      (select count(distinct ${userDays.userId})::int from ${userDays}
        where ${userDays.day} > (now() at time zone 'Europe/Moscow')::date - 7) as "activeWeek",
      (select count(distinct ${userDays.userId})::int from ${userDays}
        where ${userDays.day} > (now() at time zone 'Europe/Moscow')::date - 30) as "activeMonth",
      (select count(*)::int from ${subscriptions}
        where ${subscriptions.isActive} and ${subscriptions.expiresAt} > now()) as "withSubscription",
      (select count(*)::int from ${users} where ${users.isBanned}) as banned
  `);

  return row!;
}

export type DayRow = { day: string; active: number; joined: number };

/**
 * Активность по дням за последние `days` суток, включая сегодня.
 *
 * Дни берём из generate_series, а не из таблицы: иначе день без единого
 * захода просто выпал бы из отчёта, и провал выглядел бы как его отсутствие.
 */
export async function dailyUsers(days = 10): Promise<DayRow[]> {
  const rows = await db.execute<DayRow>(sql`
    with span as (
      select generate_series(
        -- Приведение обязательно: без него Postgres считает параметр датой,
        -- «date - date» даёт целое, и generate_series такой тип не принимает.
        (now() at time zone 'Europe/Moscow')::date - (${days - 1})::int,
        (now() at time zone 'Europe/Moscow')::date,
        interval '1 day'
      )::date as day
    )
    select
      to_char(span.day, 'DD.MM') as day,
      (select count(*)::int from ${userDays} d where d.day = span.day) as active,
      (select count(*)::int from ${users} u
        where (u.created_at at time zone 'Europe/Moscow')::date = span.day) as joined
    from span
    order by span.day desc
  `);

  return [...rows];
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
