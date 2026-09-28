import { and, desc, eq, inArray, isNull, sql as raw } from 'drizzle-orm';
import { db } from '../index.js';
import { filmGenres, films, genres } from '../schema.js';

export type Film = typeof films.$inferSelect;
export type NewFilm = typeof films.$inferInsert;

/** Колонки карточки. Сам search_vector наружу не отдаём — он служебный. */
const card = {
  id: films.id,
  code: films.code,
  titleRu: films.titleRu,
  titleOrig: films.titleOrig,
  year: films.year,
  description: films.description,
  durationMin: films.durationMin,
  rating: films.rating,
  posterFileId: films.posterFileId,
  storageChatId: films.storageChatId,
  storageMessageId: films.storageMessageId,
  fileId: films.fileId,
  fileSize: films.fileSize,
};

export type FilmCard = { [K in keyof typeof card]: Film[K] };

/**
 * Карточка для пользователя — только опубликованная.
 *
 * Фильтр по is_published здесь обязателен: id последовательные, и без него
 * диплинк `film_<id>` или кнопка «Смотреть» отдавали бы черновики и снятое
 * с публикации простым перебором чисел. Админке нужен getFilmRow.
 */
export async function getFilm(id: number): Promise<FilmCard | undefined> {
  const [film] = await db
    .select(card)
    .from(films)
    .where(and(eq(films.id, id), eq(films.isPublished, true)))
    .limit(1);
  return film;
}

type ListOptions = { limit?: number; offset?: number; genreId?: number };

export async function listPublished({
  limit = 10,
  offset = 0,
  genreId,
}: ListOptions = {}): Promise<FilmCard[]> {
  const base = db.select(card).from(films).$dynamic();

  const query = genreId
    ? base
        .innerJoin(filmGenres, eq(filmGenres.filmId, films.id))
        .where(and(eq(films.isPublished, true), eq(filmGenres.genreId, genreId)))
    : base.where(eq(films.isPublished, true));

  return query.orderBy(desc(films.createdAt)).limit(limit).offset(offset);
}

/**
 * Поиск в два приёма одним запросом:
 *   1) полнотекстовый по search_vector — ловит словоформы («колец» → «кольца»);
 *   2) триграммный по названиям — прощает опечатки («интерстелар»).
 * Оба условия идут через GIN-индексы, ранги складываются с перевесом в пользу
 * точного совпадения слов.
 */
export async function searchFilms(query: string, limit = 10): Promise<FilmCard[]> {
  const term = query.trim();
  if (!term) return [];

  const tsQuery = raw`plainto_tsquery('russian', ${term})`;
  const ftsRank = raw<number>`ts_rank(${films.searchVector}, ${tsQuery})`;
  const trgmScore = raw<number>`greatest(
    similarity(lower(${films.titleRu}), lower(${term})),
    similarity(lower(coalesce(${films.titleOrig}, '')), lower(${term}))
  )`;

  return db
    .select(card)
    .from(films)
    .where(
      and(
        eq(films.isPublished, true),
        raw`(
          ${films.searchVector} @@ ${tsQuery}
          or lower(${films.titleRu}) % lower(${term})
          or lower(coalesce(${films.titleOrig}, '')) % lower(${term})
        )`,
      ),
    )
    .orderBy(raw`${ftsRank} * 2 + ${trgmScore} desc`, desc(films.rating))
    .limit(limit);
}

export async function countPublished(): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(films)
    .where(eq(films.isPublished, true));
  return row?.count ?? 0;
}

/**
 * Поиск по коду — то, ради чего код и существует.
 * Только опубликованное: код от неготовой карточки не должен ничего открывать,
 * даже если его угадали.
 */
export async function getFilmByCode(code: string): Promise<FilmCard | undefined> {
  const [film] = await db
    .select(card)
    .from(films)
    .where(and(eq(films.code, code.trim()), eq(films.isPublished, true)))
    .limit(1);
  return film;
}

// ─── Коды ────────────────────────────────────────────────────────────

/** Сколько цифр в коде. Четыре — это десять тысяч комбинаций, хватает надолго. */
const CODE_LENGTH = 4;

export const isValidCode = (code: string): boolean => /^\d{4,6}$/.test(code.trim());

/**
 * Свободный код. Берём случайный, а не следующий по счёту: последовательные
 * коды выдают размер каталога и перебираются подряд.
 *
 * Если за десяток попыток свободного не нашлось, каталог явно перерос
 * четырёхзначные коды — добавляем разряд, а не крутим цикл до победного.
 */
export async function generateCode(): Promise<string> {
  for (let length = CODE_LENGTH; length <= 6; length++) {
    const max = 10 ** length;
    const min = 10 ** (length - 1);

    for (let attempt = 0; attempt < 10; attempt++) {
      const code = String(min + Math.floor(Math.random() * (max - min)));
      if (!(await codeTaken(code))) return code;
    }
  }

  throw new Error('не удалось подобрать свободный код фильма');
}

/** Фильм по координатам поста — не приезжал ли этот файл раньше. */
export async function getFilmByStorage(
  storageChatId: number,
  storageMessageId: number,
): Promise<Film | undefined> {
  const [film] = await db
    .select()
    .from(films)
    .where(
      and(eq(films.storageChatId, storageChatId), eq(films.storageMessageId, storageMessageId)),
    )
    .limit(1);
  return film;
}

export async function codeTaken(code: string, exceptFilmId?: number): Promise<boolean> {
  const [row] = await db
    .select({ id: films.id })
    .from(films)
    .where(eq(films.code, code.trim()))
    .limit(1);

  return row !== undefined && row.id !== exceptFilmId;
}

// ─── Админские операции ──────────────────────────────────────────────

/**
 * Карточка, заведённая до файла: описание готовится заранее, видео
 * привязывается потом. Код выдаём сразу — его уже можно публиковать.
 */
export async function createFilmCard(titleRu: string): Promise<Film> {
  const [film] = await db
    .insert(films)
    .values({ titleRu, code: await generateCode(), isPublished: false })
    .returning();

  return film!;
}

export type FileInput = {
  storageChatId: number;
  storageMessageId: number;
  fileId: string;
  fileUniqueId: string;
  fileSize?: number | undefined;
  durationMin?: number | undefined;
};

/**
 * Привязывает файл к существующей карточке.
 * Длительность не перетираем: у карточки она могла прийти из TMDB и быть
 * точнее, чем у файла.
 */
export async function attachFile(filmId: number, file: FileInput): Promise<Film | undefined> {
  const [film] = await db
    .update(films)
    .set({
      storageChatId: file.storageChatId,
      storageMessageId: file.storageMessageId,
      fileId: file.fileId,
      fileUniqueId: file.fileUniqueId,
      fileSize: file.fileSize ?? null,
      ...(file.durationMin === undefined ? {} : { durationMin: file.durationMin }),
    })
    .where(eq(films.id, filmId))
    .returning();

  return film;
}

/**
 * Переносит файл с автоматического черновика на готовую карточку.
 *
 * Сначала удаляем черновик, потом привязываем: на паре chat_id + message_id
 * и на file_unique_id стоят UNIQUE, и обратный порядок упёрся бы в них.
 * Обе операции в одной транзакции — иначе при сбое посередине файл
 * потеряется вместе с черновиком.
 */
export async function moveFileToCard(
  fromFilmId: number,
  toFilmId: number,
): Promise<Film | undefined> {
  return db.transaction(async (tx) => {
    const [source] = await tx.select().from(films).where(eq(films.id, fromFilmId)).limit(1);
    if (!source?.storageChatId || !source.storageMessageId) return undefined;

    await tx.delete(films).where(eq(films.id, fromFilmId));

    const [updated] = await tx
      .update(films)
      .set({
        storageChatId: source.storageChatId,
        storageMessageId: source.storageMessageId,
        fileId: source.fileId,
        fileUniqueId: source.fileUniqueId,
        fileSize: source.fileSize,
        ...(source.durationMin === null ? {} : { durationMin: source.durationMin }),
      })
      .where(eq(films.id, toFilmId))
      .returning();

    return updated;
  });
}

/** Карточки без файла — к ним и привязывают только что залитое видео. */
export async function listWithoutFile(limit = 20): Promise<Film[]> {
  return db
    .select()
    .from(films)
    .where(isNull(films.storageMessageId))
    .orderBy(desc(films.createdAt))
    .limit(limit);
}

export async function countWithoutFile(): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(films)
    .where(isNull(films.storageMessageId));
  return row?.count ?? 0;
}

export type DraftInput = {
  storageChatId: number;
  storageMessageId: number;
  fileId: string;
  fileUniqueId: string;
  fileSize?: number | undefined;
  durationMin?: number | undefined;
  /** Подпись к посту в канале — часто это уже готовое название. */
  titleRu: string;
};

/**
 * Заводит черновик по файлу из канала-хранилища.
 * Если этот же файл заливали раньше, возвращает существующую запись:
 * дубли в каталоге хуже, чем потерянная повторная заливка.
 */
export async function createDraft(input: DraftInput): Promise<{ film: Film; isNew: boolean }> {
  const existing = await db.query.films.findFirst({
    where: eq(films.fileUniqueId, input.fileUniqueId),
  });
  if (existing) return { film: existing, isNew: false };

  const [film] = await db
    .insert(films)
    .values({ ...input, code: await generateCode(), isPublished: false })
    .onConflictDoNothing({ target: [films.storageChatId, films.storageMessageId] })
    .returning();

  if (film) return { film, isNew: true };

  // Гонка: пока вставляли, тот же пост обработал другой апдейт.
  const raced = await db.query.films.findFirst({
    where: and(
      eq(films.storageChatId, input.storageChatId),
      eq(films.storageMessageId, input.storageMessageId),
    ),
  });
  return { film: raced!, isNew: false };
}

export async function updateFilm(id: number, patch: Partial<NewFilm>): Promise<Film | undefined> {
  const [film] = await db.update(films).set(patch).where(eq(films.id, id)).returning();
  return film;
}

export async function deleteFilm(id: number): Promise<void> {
  await db.delete(films).where(eq(films.id, id));
}

/** Черновики — файлы из канала, которым ещё не назначили карточку. */
export async function listDrafts(limit = 20): Promise<Film[]> {
  return db
    .select()
    .from(films)
    .where(eq(films.isPublished, false))
    .orderBy(desc(films.createdAt))
    .limit(limit);
}

export async function countDrafts(): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(films)
    .where(eq(films.isPublished, false));
  return row?.count ?? 0;
}

export async function getFilmRow(id: number): Promise<Film | undefined> {
  return db.query.films.findFirst({ where: eq(films.id, id) });
}

/** Переписывает жанры фильма списком tmdb-id. Неизвестные молча пропускаются. */
export async function setGenresByTmdbIds(filmId: number, tmdbIds: number[]): Promise<number> {
  await db.delete(filmGenres).where(eq(filmGenres.filmId, filmId));
  if (tmdbIds.length === 0) return 0;

  const known = await db
    .select({ id: genres.id })
    .from(genres)
    .where(inArray(genres.tmdbId, tmdbIds));
  if (known.length === 0) return 0;

  await db.insert(filmGenres).values(known.map((g) => ({ filmId, genreId: g.id })));
  return known.length;
}

export async function getFilmGenres(filmId: number): Promise<string[]> {
  const rows = await db
    .select({ name: genres.nameRu })
    .from(filmGenres)
    .innerJoin(genres, eq(genres.id, filmGenres.genreId))
    .where(eq(filmGenres.filmId, filmId));
  return rows.map((r) => r.name);
}

export async function getFilmGenreIds(filmId: number): Promise<number[]> {
  const rows = await db
    .select({ id: filmGenres.genreId })
    .from(filmGenres)
    .where(eq(filmGenres.filmId, filmId));
  return rows.map((r) => r.id);
}

/** Добавляет жанр или убирает, если он уже был. Возвращает новое состояние. */
export async function toggleGenre(filmId: number, genreId: number): Promise<boolean> {
  const deleted = await db
    .delete(filmGenres)
    .where(and(eq(filmGenres.filmId, filmId), eq(filmGenres.genreId, genreId)))
    .returning({ id: filmGenres.genreId });

  if (deleted.length > 0) return false;

  await db.insert(filmGenres).values({ filmId, genreId }).onConflictDoNothing();
  return true;
}

// ─── Каталог для пользователя ────────────────────────────────────────

export async function countByGenre(genreId: number): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(films)
    .innerJoin(filmGenres, eq(filmGenres.filmId, films.id))
    .where(and(eq(films.isPublished, true), eq(filmGenres.genreId, genreId)));
  return row?.count ?? 0;
}

/** Только жанры, в которых есть что показать: пустые разделы раздражают. */
export async function listGenresWithFilms(): Promise<{ id: number; nameRu: string; count: number }[]> {
  return db
    .select({
      id: genres.id,
      nameRu: genres.nameRu,
      count: raw<number>`count(*)::int`,
    })
    .from(genres)
    .innerJoin(filmGenres, eq(filmGenres.genreId, genres.id))
    .innerJoin(films, and(eq(films.id, filmGenres.filmId), eq(films.isPublished, true)))
    .groupBy(genres.id, genres.nameRu)
    .orderBy(genres.nameRu);
}

export async function randomPublished(): Promise<FilmCard | undefined> {
  const [film] = await db
    .select(card)
    .from(films)
    .where(eq(films.isPublished, true))
    .orderBy(raw`random()`)
    .limit(1);
  return film;
}
