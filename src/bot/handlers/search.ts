import { Composer, InlineKeyboard } from 'grammy';
import { logSearch } from '../../db/repositories/analytics.js';
import { searchFilms } from '../../db/repositories/films.js';
import { escapeHtml, plural } from '../../lib/format.js';
import type { BotContext } from '../context.js';
import { cat, filmCardKeyboard } from '../keyboards/catalog.js';
import { nav } from '../keyboards/main.js';

export const searchHandler = new Composer<BotContext>();

const MAX_RESULTS = 10;
const MIN_QUERY = 2;

const PROMPT = [
  '🔍 <b>Поиск</b>',
  '',
  'Пришлите название фильма.',
  '<i>Опечатки не страшны: «интерстелар» найдёт «Интерстеллар».</i>',
].join('\n');

searchHandler.callbackQuery(nav.search, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = 'search';
  await ctx.editMessageText(PROMPT, {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('‹ В меню', nav.home),
  });
});

/**
 * Ищем и по явному режиму поиска, и по любому тексту в чате: человек,
 * пишущий боту название фильма, ожидает результат, а не подсказку про кнопки.
 */
searchHandler.on('message:text', async (ctx, next) => {
  const query = ctx.message.text.trim();
  if (query.startsWith('/')) return next();

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

  // Единственное совпадение — сразу карточка, лишний список только мешает.
  if (films.length === 1) {
    const film = films[0]!;
    ctx.session.back = cat.home;
    await ctx.reply(`<b>${escapeHtml(film.titleRu)}</b>`, {
      parse_mode: 'HTML',
      reply_markup: filmCardKeyboard(film.id),
    });
    return;
  }

  const kb = new InlineKeyboard();
  for (const film of films) {
    const year = film.year ? ` (${film.year})` : '';
    kb.text(`${film.titleRu}${year}`.slice(0, 60), cat.film(film.id)).row();
  }
  kb.text('‹ В меню', nav.home);

  ctx.session.back = cat.home;
  await ctx.reply(
    `Нашёл ${plural(films.length, 'фильм', 'фильма', 'фильмов')} по запросу «${escapeHtml(query)}»:`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});
