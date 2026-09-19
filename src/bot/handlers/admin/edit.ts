import { Composer } from 'grammy';
import { listGenres } from '../../../db/repositories/catalog.js';
import { getFilmGenreIds, getFilmRow, toggleGenre } from '../../../db/repositories/films.js';
import { escapeHtml } from '../../../lib/format.js';
import { isTmdbConfigured } from '../../../services/tmdb.js';
import type { Awaiting, BotContext } from '../../context.js';
import { editKeyboard, fieldFrom, genresKeyboard, idsFrom } from '../../keyboards/admin.js';
import type { EditField } from '../../keyboards/admin.js';

export const adminEdit = new Composer<BotContext>();

/** Что спрашиваем и какое состояние ставим для каждого поля. */
const FIELDS: Record<EditField, { prompt: string; awaiting: Awaiting }> = {
  name: { prompt: 'Пришлите название фильма.', awaiting: 'film_name' },
  year: { prompt: 'Пришлите год выпуска, например <code>2014</code>.', awaiting: 'film_year' },
  desc: { prompt: 'Пришлите описание фильма.', awaiting: 'film_desc' },
  poster: { prompt: 'Пришлите постер картинкой.', awaiting: 'film_poster' },
};

// ─── Меню редактирования ─────────────────────────────────────────────

adminEdit.callbackQuery(/^a:ed:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  ctx.session.awaiting = undefined;

  const film = await getFilmRow(filmId!);
  if (!film) {
    await ctx.reply('Фильм не найден.');
    return;
  }

  // Показываем, что уже заполнено, а что нет — иначе непонятно, куда жать.
  const filled = [
    `Название: ${escapeHtml(film.titleRu)}`,
    `Год: ${film.year ?? '—'}`,
    `Описание: ${film.description ? 'есть' : '—'}`,
    `Постер: ${film.posterFileId ? 'есть' : '—'}`,
    `Жанры: ${(await getFilmGenreIds(film.id)).length || '—'}`,
  ].join('\n');

  await ctx.reply(`✏️ <b>Редактирование</b>\n\n${filled}`, {
    parse_mode: 'HTML',
    reply_markup: editKeyboard(film.id, isTmdbConfigured()),
  });
});

// ─── Запрос значения поля ────────────────────────────────────────────

adminEdit.callbackQuery(/^a:f:\d+:[a-z]+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  const field = fieldFrom(ctx.callbackQuery.data);
  if (!field) return;

  ctx.session.awaiting = FIELDS[field].awaiting;
  ctx.session.draftFilmId = filmId;
  await ctx.reply(FIELDS[field].prompt, { parse_mode: 'HTML' });
});

// ─── Жанры ───────────────────────────────────────────────────────────

adminEdit.callbackQuery(/^a:gs:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const [filmId] = idsFrom(ctx.callbackQuery.data);
  await ctx.reply('🎭 Отметьте жанры:', {
    reply_markup: genresKeyboard(filmId!, await listGenres(), await getFilmGenreIds(filmId!)),
  });
});

adminEdit.callbackQuery(/^a:g:\d+:\d+$/, async (ctx) => {
  const [filmId, genreId] = idsFrom(ctx.callbackQuery.data);
  const added = await toggleGenre(filmId!, genreId!);
  await ctx.answerCallbackQuery(added ? 'Добавлен' : 'Убран');

  // Перерисовываем на месте: список длинный, терять позицию неприятно.
  await ctx.editMessageReplyMarkup({
    reply_markup: genresKeyboard(filmId!, await listGenres(), await getFilmGenreIds(filmId!)),
  });
});
