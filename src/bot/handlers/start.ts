import { Composer } from 'grammy';
import type { BotContext } from '../context.js';
import { cat } from '../keyboards/catalog.js';
import { mainMenu, nav } from '../keyboards/main.js';
import { openFilmCard } from './catalog.js';

export const startHandler = new Composer<BotContext>();

const GREETING = [
  '🎬 <b>Кинотека</b>',
  '',
  'Каталог фильмов прямо в Telegram.',
  'Выберите раздел ниже.',
].join('\n');

startHandler.command('start', async (ctx) => {
  const payload = (ctx.match ?? '').trim();

  // Диплинк на конкретный фильм: /start film_42.
  const filmId = parseFilmDeeplink(payload);
  if (filmId !== undefined) {
    ctx.session.awaiting = undefined;
    ctx.session.back = cat.home;
    if (await openFilmCard(ctx, filmId)) return;

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
  await ctx.editMessageText(GREETING, {
    parse_mode: 'HTML',
    reply_markup: mainMenu(ctx.isAdmin),
  });
});

function parseFilmDeeplink(payload: string): number | undefined {
  if (!payload.startsWith('film_')) return undefined;
  const id = Number(payload.slice('film_'.length));
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
