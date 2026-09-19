import { Composer, InlineKeyboard } from 'grammy';
import { dashboard, missedQueries, topFilms } from '../../../db/repositories/analytics.js';
import { escapeHtml } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';
import { admin } from '../../keyboards/admin.js';

export const adminStats = new Composer<BotContext>();

const backKeyboard = new InlineKeyboard()
  .text('🎬 Топ фильмов', admin.statsTop)
  .text('🔍 Не нашли', admin.statsMissed)
  .row()
  .text('‹ В админку', admin.panel);

adminStats.callbackQuery(admin.stats, async (ctx) => {
  await ctx.answerCallbackQuery();
  const d = await dashboard();

  const text = [
    '📊 <b>Статистика</b>',
    '',
    `Пользователей: ${d.users} (+${d.newToday} за сутки)`,
    `Активных за сутки: ${d.dau}`,
    '',
    `Подписок сейчас: ${d.activeSubs}`,
    `Заработано: ${d.starsTotal} ⭐ (за 30 дней ${d.starsMonth} ⭐)`,
    // Конверсия считается от всей базы: это и есть вопрос «сколько из
    // пришедших платят», а не «сколько платят из тех, кто дошёл до оплаты».
    `Доля с подпиской: ${percent(d.activeSubs, d.users)}`,
    '',
    `Просмотров за сутки: ${d.viewsToday}`,
    `Прошли гейт: ${d.gatePasses}`,
    `Оплаченных приглашений: ${d.referralsPaid}`,
  ].join('\n');

  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: backKeyboard });
});

adminStats.callbackQuery(admin.statsTop, async (ctx) => {
  await ctx.answerCallbackQuery();
  const top = await topFilms(30);

  const body =
    top.length === 0
      ? ['За 30 дней просмотров не было.']
      : top.map((film, i) => `${i + 1}. ${escapeHtml(film.titleRu)} — ${film.views}`);

  await ctx.editMessageText(['🎬 <b>Топ за 30 дней</b>', '', ...body].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('‹ К статистике', admin.stats),
  });
});

adminStats.callbackQuery(admin.statsMissed, async (ctx) => {
  await ctx.answerCallbackQuery();
  const missed = await missedQueries();

  const body =
    missed.length === 0
      ? ['Пока всё находится.']
      : [
          'Искали, но не нашли — это список того, что стоит залить:',
          '',
          ...missed.map((row) => `• ${escapeHtml(row.query)} — ${row.times}`),
        ];

  await ctx.editMessageText(['🔍 <b>Пустые запросы</b>', '', ...body].join('\n'), {
    parse_mode: 'HTML',
    reply_markup: new InlineKeyboard().text('‹ К статистике', admin.stats),
  });
});

const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;
