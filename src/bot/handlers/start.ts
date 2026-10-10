import { Composer } from 'grammy';
import { getFilmByCode } from '../../db/repositories/films.js';
import type { BotContext } from '../context.js';
import { renderScreen } from '../screen.js';
import { cat } from '../keyboards/catalog.js';
import { mainMenu, nav } from '../keyboards/main.js';
import { openFilmOrGate } from './catalog.js';

export const startHandler = new Composer<BotContext>();

const GREETING = [
  '🎬 <b>Кинотека</b>',
  '',
  'Каталог фильмов прямо в Telegram.',
  'Выберите раздел ниже.',
].join('\n');

startHandler.command('start', async (ctx) => {
  const payload = (ctx.match ?? '').trim();

  // Ссылка на конкретный фильм: /start film_42 или /start code_777.
  // Второй вид нужен, чтобы код из рекламы работал и ссылкой, а не только вводом.
  const wantsFilm = payload.startsWith('film_') || payload.startsWith('code_');

  if (wantsFilm) {
    ctx.session.awaiting = undefined;
    ctx.session.back = cat.home;

    const filmId = payload.startsWith('code_')
      ? (await getFilmByCode(payload.slice('code_'.length)))?.id
      : parseFilmDeeplink(payload);

    // Пришли за конкретным фильмом — гейт спонсоров встречает сразу.
    if (filmId !== undefined && (await openFilmOrGate(ctx, filmId))) return;

    await ctx.reply('Этот фильм больше недоступен.', { reply_markup: mainMenu(ctx.isAdmin) });
    return;
  }

  await ctx.reply(GREETING, {
    parse_mode: 'HTML',
    reply_markup: mainMenu(ctx.isAdmin),
  });
});

/** Возврат в меню: правим текущее сообщение, а не плодим новые. */
startHandler.callbackQuery(nav.home, async (ctx) => {
  ctx.session.awaiting = undefined;
  await ctx.answerCallbackQuery();
  await renderScreen(ctx, GREETING, mainMenu(ctx.isAdmin));
});

function parseFilmDeeplink(payload: string): number | undefined {
  if (!payload.startsWith('film_')) return undefined;
  const id = Number(payload.slice('film_'.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
