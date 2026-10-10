import { Composer, InlineKeyboard } from 'grammy';
import { logSearch } from '../../db/repositories/analytics.js';
import { getFilmByCode, isValidCode, searchFilms } from '../../db/repositories/films.js';
import type { FilmCard } from '../../db/repositories/films.js';
import { openFilmOrGate } from './catalog.js';
import { escapeHtml, plural } from '../../lib/format.js';
import type { BotContext } from '../context.js';
import { renderScreen } from '../screen.js';
import { cat } from '../keyboards/catalog.js';
import { nav } from '../keyboards/main.js';

export const searchHandler = new Composer<BotContext>();

const MAX_RESULTS = 10;
const MIN_QUERY = 2;

const PROMPT = [
  '🔍 <b>Поиск</b>',
  '',
  'Пришлите название фильма или его код.',
  '<i>Опечатки не страшны: «интерстелар» найдёт «Интерстеллар».</i>',
].join('\n');

searchHandler.callbackQuery(nav.search, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = 'search';
  await renderScreen(ctx, PROMPT, new InlineKeyboard().text('‹ В меню', nav.home));
});

/**
 * Ищем и по явному режиму поиска, и по любому тексту в чате: человек,
 * пишущий боту название фильма, ожидает результат, а не подсказку про кнопки.
 */
searchHandler.on('message:text', async (ctx, next) => {
  const query = ctx.message.text.trim();
  if (query.startsWith('/')) return next();

  // Код проверяем раньше обычного поиска, но не вместо него: «2012» — это
  // и код, и название фильма. Не нашлось по коду — ищем как текст.
  if (isValidCode(query)) {
    const byCode = await getFilmByCode(query);
    if (byCode) {
      ctx.session.awaiting = undefined;
      ctx.session.back = cat.home;
      await logSearch(ctx.from?.id, query, 1);
      // Пришли по коду — гейт спонсоров встречает сразу, до карточки.
      await openFilmOrGate(ctx, byCode.id);
      return;
    }
  }

  if (query.length < MIN_QUERY) {
    await ctx.reply('Слишком короткий запрос — пришлите хотя бы две буквы.');
    return;
  }

  const films = await searchFilms(query, MAX_RESULTS);
  await logSearch(ctx.from?.id, query, films.length);

  ctx.session.awaiting = undefined;
  ctx.session.lastQuery = query;

  if (films.length === 0) {
    await ctx.reply(
      [
        `По запросу «${escapeHtml(query)}» ничего не нашлось.`,
        '',
        'Проверьте название или загляните в каталог.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('🎬 В каталог', nav.catalog),
      },
    );
    return;
  }

  await showResults(ctx, query, films);
});

/**
 * Список найденного: каждое название — кнопка, по ней открывается полная
 * карточка с постером и «Смотреть».
 *
 * Единственное совпадение показываем так же, списком. Раньше для него делали
 * исключение и слали голое название с кнопкой «Смотреть» — получалась
 * обрезанная карточка без постера, года и описания, то есть хуже обычной.
 */
async function showResults(ctx: BotContext, query: string, films: FilmCard[]): Promise<void> {
  const kb = new InlineKeyboard();
  for (const film of films) {
    const year = film.year ? ` (${film.year})` : '';
    kb.text(`${film.titleRu}${year}`.slice(0, 60), cat.film(film.id)).row();
  }
  kb.text('‹ В меню', nav.home);

  // «Назад» из карточки вернёт сюда же, а не в корень каталога.
  ctx.session.back = cat.searchResults;

  // Вернулись сюда из карточки — убираем её. Карточка уходит фотографией,
  // отредактировать её в текстовый список нельзя, а если просто дослать
  // список, постер останется висеть над ним.
  const trigger = ctx.callbackQuery?.message;
  if (trigger) {
    await ctx.api.deleteMessage(trigger.chat.id, trigger.message_id).catch(() => undefined);
  }

  await ctx.reply(
    `Нашёл ${plural(films.length, 'фильм', 'фильма', 'фильмов')} по запросу «${escapeHtml(query)}»:`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

/** Возврат из карточки к результатам поиска — запрос помним в сессии. */
searchHandler.callbackQuery(cat.searchResults, async (ctx) => {
  await ctx.answerCallbackQuery();

  const query = ctx.session.lastQuery;
  const films = query ? await searchFilms(query, MAX_RESULTS) : [];

  if (!query || films.length === 0) {
    await renderScreen(ctx, PROMPT, new InlineKeyboard().text('‹ В меню', nav.home));
    return;
  }

  await showResults(ctx, query, films);
});
