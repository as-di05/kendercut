import { InlineKeyboard } from 'grammy';
import type { FilmCard } from '../../db/repositories/films.js';

export const PAGE_SIZE = 8;

export const cat = {
  home: 'c:home',
  fresh: (page: number) => `c:new:${page}`,
  genres: 'c:gs',
  genre: (genreId: number, page: number) => `c:g:${genreId}:${page}`,
  film: (filmId: number) => `c:f:${filmId}`,
  random: 'c:rnd',
  /** Возврат к списку, из которого открыли карточку. Адрес лежит в сессии. */
  back: 'c:back',
  watch: (filmId: number) => `c:w:${filmId}`,
  noop: 'c:noop',
} as const;

export const numbersFrom = (data: string): number[] =>
  data
    .split(':')
    .slice(2)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n));

export const catalogRoot = new InlineKeyboard()
  .text('🆕 Новинки', cat.fresh(0))
  .row()
  .text('🎭 По жанрам', cat.genres)
  .row()
  .text('🎲 Случайный фильм', cat.random)
  .row()
  .text('‹ В меню', 'nav:home');

export function filmListKeyboard(
  films: FilmCard[],
  page: number,
  total: number,
  pageLink: (page: number) => string,
  backLink: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();

  for (const film of films) {
    const year = film.year ? ` (${film.year})` : '';
    kb.text(`${film.titleRu}${year}`.slice(0, 60), cat.film(film.id)).row();
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages > 1) {
    // Стрелки на краях не убираем, а гасим: иначе кнопки прыгают под пальцем.
    kb.text(page > 0 ? '‹' : ' ', page > 0 ? pageLink(page - 1) : cat.noop)
      .text(`${page + 1}/${pages}`, cat.noop)
      .text(page < pages - 1 ? '›' : ' ', page < pages - 1 ? pageLink(page + 1) : cat.noop)
      .row();
  }

  return kb.text('‹ Назад', backLink);
}

export const filmCardKeyboard = (filmId: number): InlineKeyboard =>
  new InlineKeyboard().text('▶️ Смотреть', cat.watch(filmId)).row().text('‹ Назад', cat.back);

export const genresKeyboard = (
  genres: { id: number; nameRu: string; count: number }[],
): InlineKeyboard => {
  const kb = new InlineKeyboard();
  genres.forEach((genre, i) => {
    kb.text(`${genre.nameRu} · ${genre.count}`, cat.genre(genre.id, 0));
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('‹ Назад', cat.home);
};
