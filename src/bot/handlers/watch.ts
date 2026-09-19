import { InlineKeyboard } from 'grammy';
import { getFilm } from '../../db/repositories/films.js';
import { plural } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { checkAccess } from '../../services/access.js';
import { deliverFilm } from '../../services/delivery.js';
import { creditReferral } from '../../services/referrals.js';
import type { BotContext } from '../context.js';
import { nav } from '../keyboards/main.js';
import { gateScreen } from '../keyboards/sponsor.js';
import { paywall } from './subscription.js';

type Options = {
  /** Пришли сюда с кнопки «Проверить» — отказ показываем всплывающим окном, а не новым экраном. */
  fromGateCheck?: boolean;
};

/**
 * «Смотреть»: проверка доступа и выдача.
 * Одна на всех — и для кнопки в карточке, и для «Проверить» в гейте,
 * иначе два пути к файлу начнут проверять разное.
 */
export async function serveFilm(
  ctx: BotContext,
  filmId: number,
  { fromGateCheck = false }: Options = {},
): Promise<void> {
  const film = await getFilm(filmId);
  if (!film) {
    await ctx.answerCallbackQuery({ text: 'Фильм больше недоступен', show_alert: true });
    return;
  }

  const access = await checkAccess(ctx.api, ctx.user.tgId);

  if (!access.allowed) {
    await denied(ctx, filmId, access, fromGateCheck);
    return;
  }

  await ctx.answerCallbackQuery('Отправляю…');
  const result = await deliverFilm(ctx.api, ctx.user.tgId, film);

  if (!result.ok) {
    await ctx.reply('Не удалось отправить файл. Мы уже знаем о проблеме.');
    logger.error({ film: film.id, user: ctx.user.tgId }, 'выдача не удалась');
    return;
  }

  // Приглашение засчитывается здесь, а не при переходе по ссылке: человек
  // добрался до фильма, значит он настоящий. Второй раз ничего не начислит.
  await creditReferral(ctx.api, ctx.user);
}

type Denied = Extract<Awaited<ReturnType<typeof checkAccess>>, { allowed: false }>;

async function denied(
  ctx: BotContext,
  filmId: number,
  access: Denied,
  fromGateCheck: boolean,
): Promise<void> {
  if (access.reason === 'sponsor_required') {
    if (fromGateCheck) {
      // Экран уже перед глазами — перерисовывать его незачем, нужен только ответ.
      const names = access.missing.map((c) => c.title).join(', ');
      await ctx.answerCallbackQuery({
        text: `Пока не вижу подписки: ${names}`,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    const { text, keyboard } = gateScreen(access.channels, filmId);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  if (access.reason === 'daily_limit') {
    await ctx.answerCallbackQuery();
    await ctx.reply(
      [
        '⏳ <b>На сегодня всё</b>',
        '',
        `Бесплатно — ${plural(access.limit, 'фильм', 'фильма', 'фильмов')} в сутки.`,
        'С подпиской ограничения нет.',
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('⭐ Оформить подписку', nav.subscription),
      },
    );
    return;
  }

  await ctx.answerCallbackQuery();
  const { text, keyboard } = await paywall();
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
