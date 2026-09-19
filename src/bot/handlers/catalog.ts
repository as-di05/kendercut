import { Composer, InlineKeyboard } from 'grammy';
import {
  countByGenre,
  countPublished,
  getFilm,
  getFilmGenres,
  listGenresWithFilms,
  listPublished,
  randomPublished,
} from '../../db/repositories/films.js';
import type { FilmCard } from '../../db/repositories/films.js';
import { escapeHtml } from '../../lib/format.js';
import { serveFilm } from './watch.js';
import type { BotContext } from '../context.js';
import {
  PAGE_SIZE,
  cat,
  catalogRoot,
  filmCardKeyboard,
  filmListKeyboard,
  genresKeyboard,
  numbersFrom,
} from '../keyboards/catalog.js';
import { nav } from '../keyboards/main.js';

export const catalogHandler = new Composer<BotContext>();

const ROOT_TEXT = '🎬 <b>Каталог</b>\n\nВыберите, как искать.';

// ─── Корень каталога ─────────────────────────────────────────────────

catalogHandler.callbackQuery([nav.catalog, cat.home], async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderRoot(ctx);
});

async function renderRoot(ctx: BotContext): Promise<void> {
  ctx.session.awaiting = undefined;

  if ((await countPublished()) === 0) {
    await ctx.editMessageText('🎬 <b>Каталог</b>\n\nПока пусто. Скоро здесь появятся фильмы.', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('‹ В меню', nav.home),
    });
    return;
  }

  await ctx.editMessageText(ROOT_TEXT, { parse_mode: 'HTML', reply_markup: catalogRoot });
}

// Кнопка-заглушка: счётчик страниц и погашенные стрелки.
catalogHandler.callbackQuery(cat.noop, (ctx) => ctx.answerCallbackQuery());

// ─── Новинки ─────────────────────────────────────────────────────────

catalogHandler.callbackQuery(/^c:new:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderFresh(ctx, numbersFrom(ctx.callbackQuery.data)[0] ?? 0);
});

async function renderFresh(ctx: BotContext, page: number): Promise<void> {
  const [films, total] = await Promise.all([
    listPublished({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }),
    countPublished(),
  ]);

  ctx.session.back = cat.fresh(page);
  await ctx.editMessageText(`🆕 <b>Новинки</b> — ${total}`, {
    parse_mode: 'HTML',
    reply_markup: filmListKeyboard(films, page, total, cat.fresh, cat.home),
  });
}

// ─── Жанры ───────────────────────────────────────────────────────────

catalogHandler.callbackQuery(cat.genres, async (ctx) => {
  await ctx.answerCallbackQuery();
  const genres = await listGenresWithFilms();

  if (genres.length === 0) {
    await ctx.editMessageText('🎭 <b>Жанры</b>\n\nУ фильмов пока не проставлены жанры.', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('‹ Назад', cat.home),
    });
    return;
  }

  await ctx.editMessageText('🎭 <b>Жанры</b>', {
    parse_mode: 'HTML',
    reply_markup: genresKeyboard(genres),
  });
});

catalogHandler.callbackQuery(/^c:g:\d+:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [genreId, page = 0] = numbersFrom(ctx.callbackQuery.data);
  await renderGenre(ctx, genreId!, page);
});

async function renderGenre(ctx: BotContext, genreId: number, page: number): Promise<void> {
  const [films, total] = await Promise.all([
    listPublished({ limit: PAGE_SIZE, offset: page * PAGE_SIZE, genreId }),
    countByGenre(genreId),
  ]);

  ctx.session.back = cat.genre(genreId, page);
  await ctx.editMessageText(`🎭 Найдено: ${total}`, {
    parse_mode: 'HTML',
    reply_markup: filmListKeyboard(films, page, total, (p) => cat.genre(genreId, p), cat.genres),
  });
}

// ─── Случайный фильм ─────────────────────────────────────────────────

catalogHandler.callbackQuery(cat.random, async (ctx) => {
  await ctx.answerCallbackQuery();
  const film = await randomPublished();
  if (!film) {
    await ctx.editMessageText('Каталог пуст.', {
      reply_markup: new InlineKeyboard().text('‹ Назад', cat.home),
    });
    return;
  }
  ctx.session.back = cat.home;
  await showFilm(ctx, film);
});

// ─── Карточка фильма ─────────────────────────────────────────────────

catalogHandler.callbackQuery(/^c:f:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = numbersFrom(ctx.callbackQuery.data);
  await openFilmCard(ctx, filmId!);
});

/** Открывает карточку по id. Используется и каталогом, и диплинком /start film_N. */
export async function openFilmCard(ctx: BotContext, filmId: number): Promise<boolean> {
  const film = await getFilm(filmId);
  if (!film) return false;
  await showFilm(ctx, film);
  return true;
}

/**
 * Возврат к списку, откуда открыли карточку: его адрес запомнен в сессии.
 * Разбираем адрес и вызываем нужную отрисовку напрямую — без повторного
 * прохода по композеру с подменой callback_data.
 */
catalogHandler.callbackQuery(cat.back, async (ctx) => {
  await ctx.answerCallbackQuery();
  const target = ctx.session.back ?? cat.home;
  const [a, b] = numbersFrom(target);

  if (target.startsWith('c:new:')) return renderFresh(ctx, a ?? 0);
  if (target.startsWith('c:g:')) return renderGenre(ctx, a!, b ?? 0);
  return renderRoot(ctx);
});

catalogHandler.callbackQuery(/^c:w:\d+$/, async (ctx) => {
  const [filmId] = numbersFrom(ctx.callbackQuery.data);
  await serveFilm(ctx, filmId!);
});

async function showFilm(ctx: BotContext, film: FilmCard): Promise<void> {
  const caption = await filmCaption(film);
  const keyboard = filmCardKeyboard(film.id);

  // Карточка бывает и фото с подписью, и текстом; Telegram не даёт превратить
  // одно в другое правкой, поэтому шлём новое сообщение, а прежнее убираем.
  const trigger = ctx.callbackQuery?.message;
  if (trigger) {
    await ctx.api.deleteMessage(trigger.chat.id, trigger.message_id).catch(() => undefined);
  }

  if (film.posterFileId) {
    await ctx.replyWithPhoto(film.posterFileId, {
      caption,
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
    return;
  }

  await ctx.reply(caption, { parse_mode: 'HTML', reply_markup: keyboard });
}

async function filmCaption(film: FilmCard): Promise<string> {
  const genreNames = await getFilmGenres(film.id);

  const meta = [
    film.year ? String(film.year) : undefined,
    film.durationMin ? `${film.durationMin} мин` : undefined,
    film.rating ? `★ ${film.rating.toFixed(1)}` : undefined,
  ].filter(Boolean);

  return [
    `<b>${escapeHtml(film.titleRu)}</b>`,
    film.titleOrig ? `<i>${escapeHtml(film.titleOrig)}</i>` : undefined,
    meta.length ? meta.join(' · ') : undefined,
    genreNames.length ? genreNames.join(', ') : undefined,
    '',
    film.description ? escapeHtml(truncate(film.description, 700)) : undefined,
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}

const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;
