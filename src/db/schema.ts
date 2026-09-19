import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  customType,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/** tsvector — своего типа у Drizzle нет, объявляем сами. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
});

/** Telegram id не влезает в int4, но безопасно живёт в JS number (< 2^53). */
const tgId = (name: string) => bigint(name, { mode: 'number' });
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

// ─── Пользователи ────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    tgId: tgId('tg_id').primaryKey(),
    username: text('username'),
    firstName: text('first_name'),
    /** Кто пригласил. Ссылка на users.tg_id, задаётся ниже через relations. */
    referrerId: tgId('referrer_id'),
    isBanned: boolean('is_banned').notNull().default(false),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index('users_referrer_idx').on(t.referrerId)],
);

// ─── Фильмы ──────────────────────────────────────────────────────────

export const films = pgTable(
  'films',
  {
    id: serial('id').primaryKey(),

    titleRu: text('title_ru').notNull(),
    titleOrig: text('title_orig'),
    year: integer('year'),
    description: text('description'),
    durationMin: integer('duration_min'),
    /** Рейтинг TMDB, 0–10. */
    rating: real('rating'),
    tmdbId: integer('tmdb_id'),
    /** Постер как file_id в Telegram — чтобы не ходить в TMDB на каждый показ. */
    posterFileId: text('poster_file_id'),

    // Где лежит сам файл. Пара chat_id + message_id — основа выдачи:
    // copyMessage не ломается при протухании file_id.
    storageChatId: tgId('storage_chat_id').notNull(),
    storageMessageId: integer('storage_message_id').notNull(),
    /** Кэш для быстрой отправки. Может протухнуть — тогда откат на copyMessage. */
    fileId: text('file_id'),
    /** Стабильный глобально, используется для защиты от повторной заливки. */
    fileUniqueId: text('file_unique_id'),
    fileSize: bigint('file_size', { mode: 'number' }),

    isPublished: boolean('is_published').notNull().default(false),
    createdAt: createdAt(),

    /**
     * Полнотекстовый индекс. Считается самой базой при вставке и апдейте,
     * поэтому рассинхронизироваться с названием не может.
     * Русское название весит больше оригинального: 'A' против 'B'.
     * Конфигурация указана явно ('russian'), иначе выражение не immutable
     * и Postgres не даст создать generated-колонку.
     */
    searchVector: tsvector('search_vector').generatedAlwaysAs(
      sql`setweight(to_tsvector('russian', coalesce(title_ru, '')), 'A') || setweight(to_tsvector('simple', coalesce(title_orig, '')), 'B')`,
    ),
  },
  (t) => [
    uniqueIndex('films_storage_msg_idx').on(t.storageChatId, t.storageMessageId),
    uniqueIndex('films_file_unique_idx').on(t.fileUniqueId),
    index('films_published_idx').on(t.isPublished, t.createdAt),
    index('films_tmdb_idx').on(t.tmdbId),

    // Поиск по словам: «властелин колец» найдёт «Властелин Колец».
    index('films_search_idx').using('gin', t.searchVector),
    // Поиск с опечатками: «интерстелар» найдёт «Интерстеллар».
    index('films_title_ru_trgm_idx').using('gin', sql`lower(${t.titleRu}) gin_trgm_ops`),
    index('films_title_orig_trgm_idx').using(
      'gin',
      sql`lower(coalesce(${t.titleOrig}, '')) gin_trgm_ops`,
    ),
  ],
);

export const genres = pgTable('genres', {
  id: serial('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  nameRu: text('name_ru').notNull(),
  tmdbId: integer('tmdb_id'),
});

export const filmGenres = pgTable(
  'film_genres',
  {
    filmId: integer('film_id')
      .notNull()
      .references(() => films.id, { onDelete: 'cascade' }),
    genreId: integer('genre_id')
      .notNull()
      .references(() => genres.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.filmId, t.genreId] }), index('film_genres_genre_idx').on(t.genreId)],
);

// ─── Подписки и платежи ──────────────────────────────────────────────

export const subscriptionSource = pgEnum('subscription_source', [
  'payment',
  'referral',
  'admin',
  'trial',
]);

export const paymentStatus = pgEnum('payment_status', ['pending', 'paid', 'refunded', 'failed']);

export const plans = pgTable('plans', {
  id: serial('id').primaryKey(),
  code: text('code').notNull().unique(),
  title: text('title').notNull(),
  days: integer('days').notNull(),
  priceStars: integer('price_stars').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  sort: integer('sort').notNull().default(0),
});

export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    planId: integer('plan_id').references(() => plans.id, { onDelete: 'set null' }),
    source: subscriptionSource('source').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    isActive: boolean('is_active').notNull().default(true),
    /** Порог напоминания, который уже отправлен: 3 или 1 день. */
    lastReminderDays: integer('last_reminder_days'),
    /** Подписка Telegram с автосписанием: о конце срока напоминать не нужно. */
    autoRenew: boolean('auto_renew').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    // Основной запрос гварда: активная подписка юзера с максимальным expires_at.
    index('subscriptions_user_active_idx').on(t.userId, t.isActive, t.expiresAt),
    // Для джобы, снимающей доступ по истечении.
    index('subscriptions_expiry_idx').on(t.expiresAt).where(sql`${t.isActive}`),
  ],
);

export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    planId: integer('plan_id').references(() => plans.id, { onDelete: 'set null' }),
    subscriptionId: integer('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    /** В Stars — целое число XTR. */
    amount: integer('amount').notNull(),
    currency: text('currency').notNull().default('XTR'),
    status: paymentStatus('status').notNull().default('pending'),
    /**
     * Идентификатор платежа от Telegram. UNIQUE даёт идемпотентность:
     * повторный successful_payment не продлит подписку дважды.
     */
    telegramPaymentChargeId: text('telegram_payment_charge_id').unique(),
    createdAt: createdAt(),
  },
  (t) => [index('payments_user_idx').on(t.userId, t.createdAt)],
);

// ─── Спонсорские каналы ──────────────────────────────────────────────

export const sponsorChannels = pgTable(
  'sponsor_channels',
  {
    id: serial('id').primaryKey(),
    chatId: tgId('chat_id').notNull().unique(),
    title: text('title').notNull(),
    /** Без @. Пусто у приватных каналов. */
    username: text('username'),
    inviteLink: text('invite_link'),
    isPrivate: boolean('is_private').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sort: integer('sort').notNull().default(0),
    /** Срок размещения — по нему канал сам уходит из гейта. */
    startsAt: timestamp('starts_at', { withTimezone: true }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    /** Сколько подписчиков обещано партнёру и сколько уже пришло. */
    targetJoins: integer('target_joins'),
    joinedCount: integer('joined_count').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('sponsor_channels_active_idx').on(t.isActive, t.sort)],
);

export const sponsorPasses = pgTable(
  'sponsor_passes',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    channelId: integer('channel_id')
      .notNull()
      .references(() => sponsorChannels.id, { onDelete: 'cascade' }),
    passedAt: timestamp('passed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Один зачёт на пару юзер-канал: счётчик партнёра не должен накручиваться.
    uniqueIndex('sponsor_passes_user_channel_idx').on(t.userId, t.channelId),
  ],
);

// ─── Рефералы ────────────────────────────────────────────────────────

export const referrals = pgTable(
  'referrals',
  {
    id: serial('id').primaryKey(),
    inviterId: tgId('inviter_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    /** Приглашённый может прийти только один раз — отсюда unique. */
    invitedId: tgId('invited_id')
      .notNull()
      .unique()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    bonusDays: integer('bonus_days').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('referrals_inviter_idx').on(t.inviterId)],
);

// ─── Аналитика и служебное ───────────────────────────────────────────

export const views = pgTable(
  'views',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    filmId: integer('film_id')
      .notNull()
      .references(() => films.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('views_film_idx').on(t.filmId, t.createdAt),
    // Дневной лимит бесплатных просмотров считается по этому индексу.
    index('views_user_idx').on(t.userId, t.createdAt),
  ],
);

export const searchQueries = pgTable(
  'search_queries',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id').references(() => users.tgId, { onDelete: 'set null' }),
    query: text('query').notNull(),
    resultsCount: integer('results_count').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    // Отчёт «искали, но не нашли» — что заливать следующим.
    index('search_queries_empty_idx').on(t.createdAt).where(sql`${t.resultsCount} = 0`),
  ],
);

export const deliveredMessages = pgTable(
  'delivered_messages',
  {
    id: serial('id').primaryKey(),
    userId: tgId('user_id')
      .notNull()
      .references(() => users.tgId, { onDelete: 'cascade' }),
    chatId: tgId('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
    deleteAt: timestamp('delete_at', { withTimezone: true }).notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    // Очередь на удаление: берём всё, чему пора и что ещё не удалено.
    index('delivered_messages_pending_idx').on(t.deleteAt).where(sql`${t.deletedAt} is null`),
  ],
);

export const broadcastStatus = pgEnum('broadcast_status', [
  'draft',
  'running',
  'done',
  'cancelled',
]);

export const broadcasts = pgTable('broadcasts', {
  id: serial('id').primaryKey(),
  text: text('text').notNull(),
  /** Сегмент получателей: {"segment": "subscribers"} и т.п. */
  filter: jsonb('filter').notNull().default({}),
  status: broadcastStatus('status').notNull().default('draft'),
  sent: integer('sent').notNull().default(0),
  failed: integer('failed').notNull().default(0),
  /** Сколько получателей насчитали на старте — для прогресса. */
  total: integer('total').notNull().default(0),
  /**
   * Курсор: чей id разобрали последним. Рассылка идёт по возрастанию tg_id,
   * поэтому после перезапуска она продолжается с этого места, а не с начала —
   * иначе половина людей получила бы сообщение дважды.
   */
  lastUserId: tgId('last_user_id'),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  createdAt: createdAt(),
});

// ─── Связи ───────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ one, many }) => ({
  referrer: one(users, { fields: [users.referrerId], references: [users.tgId] }),
  subscriptions: many(subscriptions),
  payments: many(payments),
  views: many(views),
}));

export const filmsRelations = relations(films, ({ many }) => ({
  filmGenres: many(filmGenres),
  views: many(views),
}));

export const genresRelations = relations(genres, ({ many }) => ({
  filmGenres: many(filmGenres),
}));

export const filmGenresRelations = relations(filmGenres, ({ one }) => ({
  film: one(films, { fields: [filmGenres.filmId], references: [films.id] }),
  genre: one(genres, { fields: [filmGenres.genreId], references: [genres.id] }),
}));

export const subscriptionsRelations = relations(subscriptions, ({ one }) => ({
  user: one(users, { fields: [subscriptions.userId], references: [users.tgId] }),
  plan: one(plans, { fields: [subscriptions.planId], references: [plans.id] }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  user: one(users, { fields: [payments.userId], references: [users.tgId] }),
  plan: one(plans, { fields: [payments.planId], references: [plans.id] }),
  subscription: one(subscriptions, {
    fields: [payments.subscriptionId],
    references: [subscriptions.id],
  }),
}));

export const sponsorChannelsRelations = relations(sponsorChannels, ({ many }) => ({
  passes: many(sponsorPasses),
}));

export const sponsorPassesRelations = relations(sponsorPasses, ({ one }) => ({
  user: one(users, { fields: [sponsorPasses.userId], references: [users.tgId] }),
  channel: one(sponsorChannels, {
    fields: [sponsorPasses.channelId],
    references: [sponsorChannels.id],
  }),
}));
