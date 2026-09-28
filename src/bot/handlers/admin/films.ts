import { Composer, InlineKeyboard } from 'grammy';
import {
  attachFile,
  codeTaken,
  countDrafts,
  createFilmCard,
  deleteFilm,
  generateCode,
  getFilmByStorage,
  getFilmGenres,
  getFilmRow,
  isValidCode,
  listDrafts,
  listPublished,
  listWithoutFile,
  moveFileToCard,
  setGenresByTmdbIds,
  updateFilm,
} from '../../../db/repositories/films.js';
import type { Film } from '../../../db/repositories/films.js';
import { config } from '../../../lib/config.js';
import { escapeHtml, fitCaption, plural } from '../../../lib/format.js';
import { logger } from '../../../lib/logger.js';
import { getMovie, isTmdbConfigured, searchMovies } from '../../../services/tmdb.js';
import type { BotContext } from '../../context.js';
import { renderScreen } from '../../screen.js';
import { admin, cardKeyboard, idsFrom, panelKeyboard } from '../../keyboards/admin.js';

export const adminFilms = new Composer<BotContext>();

const NO_TITLE = 'Без названия';

// ─── Панель и списки ─────────────────────────────────────────────────

adminFilms.callbackQuery(admin.panel, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = undefined;
  await renderScreen(ctx, '🛠 <b>Админка</b>\n\nВыберите раздел.', panelKeyboard(await countDrafts()));
});

adminFilms.callbackQuery(admin.drafts, async (ctx) => {
  await ctx.answerCallbackQuery();
  const drafts = await listDrafts();
  if (drafts.length === 0) {
    await renderScreen(
      ctx,
      '📥 <b>Неоформленные</b>\n\nПусто. Залейте фильм в канал-хранилище — он появится здесь.',
      new InlineKeyboard().text('‹ Назад', admin.panel),
    );
    return;
  }
  await renderScreen(ctx, `📥 <b>Неоформленные</b> — ${drafts.length}`, filmList(drafts));
});

adminFilms.callbackQuery(admin.published, async (ctx) => {
  await ctx.answerCallbackQuery();
  const published = await listPublished({ limit: 20 });
  const rows = await Promise.all(published.map((f) => getFilmRow(f.id)));
  const films = rows.filter((f): f is Film => f !== undefined);

  await renderScreen(
    ctx,
    films.length ? `🎬 <b>Опубликованные</b> — ${films.length}` : '🎬 Опубликованных пока нет.',
    filmList(films),
  );
});

function filmList(films: Film[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const film of films) {
    const year = film.year ? ` (${film.year})` : '';
    kb.text(`${film.titleRu}${year}`.slice(0, 60), admin.card(film.id)).row();
  }
  return kb.text('‹ Назад', admin.panel);
}

// ─── Карточка ────────────────────────────────────────────────────────

adminFilms.callbackQuery(/^a:card:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  await showCard(ctx, filmId!);
});

// ─── Карточка без файла ──────────────────────────────────────────────

/**
 * Фильм заводится с названия, файл привязывается потом.
 * Так описание и код готовятся заранее — например, пока видео ещё качается.
 */
adminFilms.callbackQuery(admin.filmNew, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = 'film_new';
  ctx.session.draftFilmId = undefined;

  await ctx.reply(
    [
      'Пришлите название фильма — заведу карточку без файла.',
      '',
      'Видео можно привязать позже: залейте его в канал-хранилище',
      'и выберите эту карточку, либо перешлите пост сюда.',
    ].join('\n'),
  );
});

// ─── Код фильма ──────────────────────────────────────────────────────

adminFilms.callbackQuery(/^a:code:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);

  ctx.session.awaiting = 'film_code';
  ctx.session.draftFilmId = filmId;

  const film = await getFilmRow(filmId!);
  await ctx.reply(
    [
      `Код сейчас: <code>${film?.code ?? '—'}</code>`,
      '',
      'Пришлите новый — от 4 до 6 цифр.',
      'Или <code>-</code>, чтобы бот подобрал свободный сам.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});

// ─── Привязка файла к карточке ───────────────────────────────────────

adminFilms.callbackQuery(/^a:att:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);

  ctx.session.awaiting = 'film_attach';
  ctx.session.draftFilmId = filmId;

  await ctx.reply(
    [
      'Перешлите сюда пост с фильмом из канала-хранилища.',
      '',
      'Если видео ещё не залито — залейте его в канал, бот пришлёт',
      'уведомление, и там будет кнопка «📎 К готовой карточке».',
    ].join('\n'),
  );
});

/** Список карточек без файла — куда пристроить только что залитое видео. */
adminFilms.callbackQuery(/^a:attl:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [fileFilmId] = idsFrom(ctx.callbackQuery.data);

  const cards = await listWithoutFile();
  if (cards.length === 0) {
    await ctx.reply('Карточек без файла нет — сначала заведите её кнопкой «➕ Добавить фильм».');
    return;
  }

  const kb = new InlineKeyboard();
  for (const film of cards) {
    const year = film.year ? ` (${film.year})` : '';
    kb.text(`${film.titleRu}${year}`.slice(0, 60), admin.attachTo(fileFilmId!, film.id)).row();
  }
  kb.text('‹ Отмена', admin.card(fileFilmId!));

  await ctx.reply('К какой карточке привязать этот файл?', { reply_markup: kb });
});

adminFilms.callbackQuery(/^a:att2:\d+:\d+$/, async (ctx) => {
  const [fileFilmId, cardId] = idsFrom(ctx.callbackQuery.data);

  const moved = await moveFileToCard(fileFilmId!, cardId!);
  if (!moved) {
    await ctx.answerCallbackQuery({ text: 'Не вышло — файла уже нет', show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery('Файл привязан');
  await showCard(ctx, cardId!);
});

/**
 * Пересланный из хранилища пост — второй способ привязать файл.
 * Берём координаты из forward_origin: file_id у пересланного сообщения
 * тот же, а вот message_id — уже пересылки, и для copyMessage не годится.
 */
adminFilms.on(['message:video', 'message:document'], async (ctx, next) => {
  const { awaiting, draftFilmId } = ctx.session;
  if (awaiting !== 'film_attach' || !draftFilmId) return next();

  const origin = ctx.message.forward_origin;
  if (origin?.type !== 'channel') {
    await ctx.reply('Нужен именно пересланный пост из канала-хранилища.');
    return;
  }
  if (origin.chat.id !== config.STORAGE_CHANNEL_ID) {
    await ctx.reply('Этот пост не из канала-хранилища.');
    return;
  }

  const media = ctx.message.video ?? ctx.message.document;
  if (!media) {
    await ctx.reply('В пересланном посте нет видео.');
    return;
  }

  ctx.session.awaiting = undefined;
  ctx.session.draftFilmId = undefined;

  // Этот пост мог уже приехать из канала и завести свой черновик —
  // тогда переносим файл с него, чтобы не оставлять дубль в каталоге.
  const existing = await getFilmByStorage(origin.chat.id, origin.message_id);
  if (existing && existing.id !== draftFilmId) {
    await moveFileToCard(existing.id, draftFilmId);
  } else {
    await attachFile(draftFilmId, {
      storageChatId: origin.chat.id,
      storageMessageId: origin.message_id,
      fileId: media.file_id,
      fileUniqueId: media.file_unique_id,
      fileSize: media.file_size,
      // Длительность есть только у video: документом фильм приходит, когда
      // Telegram не распознал контейнер, и тогда её взять неоткуда.
      durationMin: ctx.message.video?.duration
        ? Math.round(ctx.message.video.duration / 60)
        : undefined,
    });
  }

  await ctx.reply('Файл привязан.');
  await showCard(ctx, draftFilmId);
});

// ─── Заполнение названия ─────────────────────────────────────────────

adminFilms.callbackQuery(/^a:fill:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);

  ctx.session.awaiting = 'film_title';
  ctx.session.draftFilmId = filmId;

  const hint = isTmdbConfigured()
    ? 'Пришлите название фильма — поищу карточку в TMDB.'
    : 'Пришлите название фильма.\n\n<i>TMDB_API_KEY не задан, поэтому описание и постер придётся заполнить вручную.</i>';

  await ctx.reply(hint, { parse_mode: 'HTML' });
});

adminFilms.callbackQuery(/^a:man:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);

  ctx.session.awaiting = 'film_manual';
  ctx.session.draftFilmId = filmId;

  await ctx.reply(
    ['Пришлите данные одной строкой:', '', '<code>Название | Год | Описание</code>', '', 'Год и описание можно опустить.'].join('\n'),
    { parse_mode: 'HTML' },
  );
});

adminFilms.on('message:text', async (ctx, next) => {
  const { awaiting, draftFilmId } = ctx.session;
  if (!awaiting) return next();

  // Команды сюда не доходят: их отсекает resetOnCommand выше по цепочке.
  const text = ctx.message.text.trim();

  // Новая карточка — единственный ввод без уже существующего фильма.
  if (awaiting === 'film_new') return createCard(ctx, text);
  if (!draftFilmId) return next();

  switch (awaiting) {
    case 'film_code':
      return saveCode(ctx, draftFilmId, text);
    case 'film_title':
      return handleTitleSearch(ctx, draftFilmId, text);
    case 'film_manual':
      return handleManualInput(ctx, draftFilmId, text);
    case 'film_name':
      return saveField(ctx, draftFilmId, { titleRu: text });
    case 'film_desc':
      return saveField(ctx, draftFilmId, { description: text });
    case 'film_year':
      return saveYear(ctx, draftFilmId, text);
    default:
      return next();
  }
});

async function createCard(ctx: BotContext, title: string): Promise<void> {
  if (title.length < 2) {
    await ctx.reply('Название слишком короткое.');
    return;
  }

  const film = await createFilmCard(title.slice(0, 200));
  ctx.session.awaiting = undefined;

  await ctx.reply(
    [
      `Карточка заведена, код фильма: <code>${film.code}</code>`,
      '',
      'Осталось заполнить описание и привязать файл.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
  await showCard(ctx, film.id);
}

async function saveCode(ctx: BotContext, filmId: number, text: string): Promise<void> {
  const code = text === '-' ? await generateCode() : text;

  if (!isValidCode(code)) {
    await ctx.reply('Код — от 4 до 6 цифр. Или «-», чтобы подобрал бот.');
    return;
  }
  if (await codeTaken(code, filmId)) {
    await ctx.reply('Такой код уже занят другим фильмом.');
    return;
  }

  await updateFilm(filmId, { code });
  ctx.session.awaiting = undefined;
  ctx.session.draftFilmId = undefined;

  await ctx.reply(`Код фильма: <code>${code}</code>`, { parse_mode: 'HTML' });
  await showCard(ctx, filmId);
}

/** Постер приходит картинкой — берём самый крупный размер. */
adminFilms.on('message:photo', async (ctx, next) => {
  const { awaiting, draftFilmId } = ctx.session;
  if (awaiting !== 'film_poster' || !draftFilmId) return next();

  const fileId = ctx.message.photo.at(-1)?.file_id;
  if (!fileId) {
    await ctx.reply('Не смог прочитать картинку, попробуйте ещё раз.');
    return;
  }
  return saveField(ctx, draftFilmId, { posterFileId: fileId });
});

async function saveField(
  ctx: BotContext,
  filmId: number,
  patch: Parameters<typeof updateFilm>[1],
): Promise<void> {
  await updateFilm(filmId, patch);
  ctx.session.awaiting = undefined;
  ctx.session.draftFilmId = undefined;
  await showCard(ctx, filmId);
}

async function saveYear(ctx: BotContext, filmId: number, text: string): Promise<void> {
  const year = Number(text);
  if (!Number.isInteger(year) || year < 1880 || year > 2100) {
    await ctx.reply('Не похоже на год. Пришлите четыре цифры, например 2014.');
    return;
  }
  return saveField(ctx, filmId, { year });
}

async function handleTitleSearch(ctx: BotContext, filmId: number, query: string): Promise<void> {
  const results = await searchMovies(query);

  if (results.length === 0) {
    // Ни ключа, ни совпадений — не тупик: сохраняем введённое как название.
    await updateFilm(filmId, { titleRu: query });
    ctx.session.awaiting = undefined;
    ctx.session.draftFilmId = undefined;

    await ctx.reply(
      [
        isTmdbConfigured()
          ? 'В TMDB ничего не нашлось — сохранил название как есть.'
          : 'Сохранил название.',
        'Описание, год, постер и жанры можно задать через «✏️ Редактировать».',
      ].join('\n'),
    );
    await showCard(ctx, filmId);
    return;
  }

  const kb = new InlineKeyboard();
  for (const movie of results) {
    const year = movie.year ? ` (${movie.year})` : '';
    kb.text(`${movie.titleRu}${year}`.slice(0, 60), admin.pick(filmId, movie.tmdbId)).row();
  }
  kb.text('Ничего не подходит — ввести вручную', admin.manual(filmId));

  await ctx.reply(`Нашёл ${plural(results.length, 'вариант', 'варианта', 'вариантов')}:`, {
    reply_markup: kb,
  });
}

async function handleManualInput(ctx: BotContext, filmId: number, text: string): Promise<void> {
  const [title, yearRaw, ...rest] = text.split('|').map((part) => part.trim());
  if (!title) {
    await ctx.reply('Название не может быть пустым. Попробуйте ещё раз.');
    return;
  }

  const year = Number(yearRaw);
  await updateFilm(filmId, {
    titleRu: title,
    year: Number.isInteger(year) && year > 1880 && year < 2100 ? year : null,
    description: rest.join(' | ') || null,
  });

  ctx.session.awaiting = undefined;
  ctx.session.draftFilmId = undefined;
  await showCard(ctx, filmId);
}

adminFilms.callbackQuery(/^a:pick:\d+:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery('Загружаю данные…');
  const [filmId, tmdbId] = idsFrom(ctx.callbackQuery.data);

  const movie = await getMovie(tmdbId!);
  if (!movie) {
    await ctx.reply('TMDB не ответил. Попробуйте ещё раз или введите данные вручную.');
    return;
  }

  const film = await getFilmRow(filmId!);
  await updateFilm(filmId!, {
    titleRu: movie.titleRu,
    titleOrig: movie.titleOrig ?? null,
    year: movie.year ?? null,
    description: movie.description ?? null,
    rating: movie.rating ?? null,
    tmdbId: movie.tmdbId,
    // Длительность самого файла точнее официальной — её и оставляем.
    durationMin: film?.durationMin ?? movie.durationMin ?? null,
  });

  const genreCount = await setGenresByTmdbIds(filmId!, movie.genreIds);
  logger.info({ film: filmId, tmdb: tmdbId, genres: genreCount }, 'карточка заполнена из TMDB');

  ctx.session.awaiting = undefined;
  ctx.session.draftFilmId = undefined;
  await showCard(ctx, filmId!, movie.posterUrl);
});

// ─── Публикация и удаление ───────────────────────────────────────────

adminFilms.callbackQuery(/^a:pub1:\d+$/, async (ctx) => {
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  const film = await getFilmRow(filmId!);

  if (!film || film.titleRu === NO_TITLE) {
    await ctx.answerCallbackQuery({
      text: 'Сначала задайте название',
      show_alert: true,
    });
    return;
  }

  // Опубликованная карточка без файла — это кнопка «Смотреть», которая
  // ничего не отдаёт. Лучше не пустить сюда, чем разбираться потом.
  if (film.storageMessageId === null && !film.fileId) {
    await ctx.answerCallbackQuery({
      text: 'Сначала привяжите файл — смотреть пока нечего',
      show_alert: true,
    });
    return;
  }

  await updateFilm(filmId!, { isPublished: true });
  await ctx.answerCallbackQuery('Опубликован');
  await showCard(ctx, filmId!);
});

adminFilms.callbackQuery(/^a:pub0:\d+$/, async (ctx) => {
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  await updateFilm(filmId!, { isPublished: false });
  await ctx.answerCallbackQuery('Снят с публикации');
  await showCard(ctx, filmId!);
});

adminFilms.callbackQuery(/^a:del\?:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  await ctx.reply('Удалить фильм из каталога? Файл в канале останется.', {
    reply_markup: new InlineKeyboard()
      .text('Да, удалить', admin.doDelete(filmId!))
      .text('Отмена', admin.card(filmId!)),
  });
});

adminFilms.callbackQuery(/^a:del!:\d+$/, async (ctx) => {
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  await deleteFilm(filmId!);
  await ctx.answerCallbackQuery('Удалён');
  await renderScreen(
    ctx,
    '🗑 Фильм удалён из каталога.',
    new InlineKeyboard().text('‹ В админку', admin.panel),
  );
});

// ─── Отрисовка карточки ──────────────────────────────────────────────

/**
 * Всегда отправляет новое сообщение, а старое убирает.
 * Редактировать нельзя: карточка бывает и текстом, и фото с подписью,
 * а Telegram не даёт превратить одно в другое.
 */
async function showCard(ctx: BotContext, filmId: number, posterUrl?: string): Promise<void> {
  const film = await getFilmRow(filmId);
  if (!film) {
    await ctx.reply('Фильм не найден — возможно, его уже удалили.');
    return;
  }

  const caption = await cardText(film);
  const hasFile = film.storageMessageId !== null || film.fileId !== null;
  const keyboard = cardKeyboard(film.id, film.isPublished, hasFile);

  // Убираем сообщение, с кнопки которого пришли, чтобы не копить хвост карточек.
  const trigger = ctx.callbackQuery?.message;
  if (trigger) {
    await ctx.api.deleteMessage(trigger.chat.id, trigger.message_id).catch(() => undefined);
  }

  const poster = film.posterFileId ?? posterUrl;
  if (poster) {
    try {
      const sent = await ctx.replyWithPhoto(poster, {
        caption,
        parse_mode: 'HTML',
        reply_markup: keyboard,
      });
      // Постер прилетел ссылкой: Telegram скачал его к себе, запоминаем file_id,
      // чтобы больше не ходить в TMDB за картинкой.
      const fileId = sent.photo.at(-1)?.file_id;
      if (fileId && fileId !== film.posterFileId) await updateFilm(filmId, { posterFileId: fileId });
      return;
    } catch (err) {
      logger.warn({ film: filmId, err }, 'постер не отправился, показываю карточку текстом');
    }
  }

  await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function cardText(film: Film): Promise<string> {
  const genreNames = await getFilmGenres(film.id);

  const meta = [
    film.year ? String(film.year) : undefined,
    film.durationMin ? `${film.durationMin} мин` : undefined,
    film.rating ? `★ ${film.rating.toFixed(1)}` : undefined,
  ].filter(Boolean);

  const hasFile = film.storageMessageId !== null || film.fileId !== null;
  const status = film.isPublished ? '✅ Опубликован' : '📥 Черновик';
  const head = [
    `<b>${escapeHtml(film.titleRu)}</b>`,
    film.titleOrig ? `<i>${escapeHtml(film.titleOrig)}</i>` : undefined,
    meta.length ? meta.join(' · ') : undefined,
    genreNames.length ? escapeHtml(genreNames.join(', ')) : undefined,
    '',
    `🔢 Код: <code>${film.code ?? '—'}</code>`,
    hasFile ? '🎞 Файл привязан' : '📎 Файла нет — публиковать нельзя',
    status,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  // Карточка уходит подписью к постеру — тот же предел 1024 символа.
  return film.description
    ? fitCaption(head, film.description)
    : `${head}\n\n<i>Описание не заполнено</i>`;
}
