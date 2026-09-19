import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql as raw } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { logger } from '../lib/logger.js';
import { db } from './index.js';
import { genres, plans } from './schema.js';

// src/db/bootstrap.ts и dist/db/bootstrap.js лежат на одной глубине,
// поэтому один и тот же путь работает и в dev, и в проде.
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export async function applyMigrations(): Promise<void> {
  logger.info({ migrationsFolder }, 'применяю миграции');
  await migrate(db, { migrationsFolder });
  logger.info('миграции применены');
}

/** Жанры TMDB с русскими названиями — id совпадают с tmdb, чтобы маппить импорт напрямую. */
const GENRES = [
  { tmdbId: 28, slug: 'action', nameRu: 'Боевик' },
  { tmdbId: 12, slug: 'adventure', nameRu: 'Приключения' },
  { tmdbId: 16, slug: 'animation', nameRu: 'Мультфильм' },
  { tmdbId: 35, slug: 'comedy', nameRu: 'Комедия' },
  { tmdbId: 80, slug: 'crime', nameRu: 'Криминал' },
  { tmdbId: 99, slug: 'documentary', nameRu: 'Документальный' },
  { tmdbId: 18, slug: 'drama', nameRu: 'Драма' },
  { tmdbId: 10751, slug: 'family', nameRu: 'Семейный' },
  { tmdbId: 14, slug: 'fantasy', nameRu: 'Фэнтези' },
  { tmdbId: 36, slug: 'history', nameRu: 'Исторический' },
  { tmdbId: 27, slug: 'horror', nameRu: 'Ужасы' },
  { tmdbId: 10402, slug: 'music', nameRu: 'Музыка' },
  { tmdbId: 9648, slug: 'mystery', nameRu: 'Детектив' },
  { tmdbId: 10749, slug: 'romance', nameRu: 'Мелодрама' },
  { tmdbId: 878, slug: 'sci-fi', nameRu: 'Фантастика' },
  { tmdbId: 53, slug: 'thriller', nameRu: 'Триллер' },
  { tmdbId: 10752, slug: 'war', nameRu: 'Военный' },
  { tmdbId: 37, slug: 'western', nameRu: 'Вестерн' },
];

/** Стартовые тарифы. Дальше цены правятся в админке, сиды их не трогают. */
const PLANS = [
  { code: 'month', title: '1 месяц', days: 30, priceStars: 149, sort: 1 },
  { code: 'quarter', title: '3 месяца', days: 90, priceStars: 349, sort: 2 },
  { code: 'year', title: '1 год', days: 365, priceStars: 999, sort: 3 },
];

/** Значение из вставляемой строки внутри ON CONFLICT DO UPDATE. */
const excluded = (column: string) => raw.raw(`excluded.${column}`);

/**
 * Справочники: жанры всегда приводим к эталону, тарифы — только заводим.
 *
 * Тарифы обновлять нельзя: цену меняют в админке, и повторный прогон сидов
 * (а на проде он случается при каждом старте) откатил бы её обратно.
 */
export async function seedDefaults(): Promise<void> {
  // Уникален slug, а не tmdb_id: жанр может жить и без соответствия в TMDB.
  await db
    .insert(genres)
    .values(GENRES)
    .onConflictDoUpdate({
      target: genres.slug,
      set: { nameRu: excluded('name_ru'), tmdbId: excluded('tmdb_id') },
    });

  await db.insert(plans).values(PLANS).onConflictDoNothing({ target: plans.code });

  logger.debug({ genres: GENRES.length, plans: PLANS.length }, 'справочники на месте');
}
