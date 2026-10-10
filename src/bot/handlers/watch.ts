import { InlineKeyboard } from 'grammy';
import { getFilm } from '../../db/repositories/films.js';
import { plural } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { checkAccess } from '../../services/access.js';
import { deliverFilm } from '../../services/delivery.js';
import { creditReferral } from '../../services/referrals.js';
import type { BotContext } from '../context.js';
import { nav } from '../keyboards/main.js';
import { gateScreen, missingText, type GateMode } from '../keyboards/sponsor.js';
import { paywall } from './subscription.js';

type Options = {
  /** Пришли сюда с кнопки «Проверить» — отказ показываем всплывающим окном, а не новым экраном. */
  fromGateCheck?: boolean;
};

/**
 * Гасит часики на кнопке — но только если пришли действительно с кнопки.
 * По коду и по ссылке попадают сюда обычным сообщением, и тогда
 * answerCallbackQuery падает с «Missing information for API call».
 */
const ack = async (ctx: BotContext, text?: string): Promise<void> => {
  if (ctx.callbackQuery) await ctx.answerCallbackQuery(text);
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
    // С кнопки отвечаем всплывающим окном: устаревшая кнопка не должна
    // засорять чат новым сообщением.
    const text = 'Фильм больше недоступен';
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text, show_alert: true });
    else await ctx.reply(text);
    return;
  }

  // У карточки без файла кнопки «Смотреть» не бывает, но она могла остаться
  // в старом сообщении или в сохранённом чате. Тупика быть не должно.
  if (!isDeliverable(film)) {
    await ack(ctx);
    await comingSoon(ctx);
    return;
  }

  const access = await checkAccess(ctx.api, ctx.user.tgId, ctx.isAdmin);

  if (!access.allowed) {
    await denied(ctx, filmId, access, fromGateCheck);
    return;
  }

  await ack(ctx, 'Отправляю…');
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

/** Фильм, к которому ещё не привязали файл: карточка есть, смотреть нечего. */
export const isDeliverable = (film: { storageMessageId: number | null; fileId: string | null }): boolean =>
  film.storageMessageId !== null || film.fileId !== null;

export async function comingSoon(ctx: BotContext): Promise<void> {
  await ctx.reply(
    ['⏳ <b>Фильм скоро появится</b>', '', 'Карточка уже есть, файл добавим в ближайшее время.'].join(
      '\n',
    ),
    {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('🎬 В каталог', nav.catalog),
    },
  );
}

/**
 * Показывает, почему доступа нет: гейт спонсоров, дневной лимит или пейволл.
 * Вынесено наружу, потому что этим же экраном встречают и тех, кто пришёл
 * по коду: гейт должен появляться сразу, а не после нажатия «Смотреть».
 */
export async function denied(
  ctx: BotContext,
  filmId: number,
  access: Denied,
  fromGateCheck = false,
  mode: GateMode = 'watch',
): Promise<void> {
  if (access.reason === 'sponsor_required') {
    if (fromGateCheck) {
      // Экран уже перед глазами — перерисовывать его незачем, нужен только ответ.
      await ctx.answerCallbackQuery({ text: missingText(access.missing), show_alert: true });
      return;
    }

    await ack(ctx);
    const { text, keyboard } = gateScreen(access.channels, filmId, mode);
    await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  if (access.reason === 'daily_limit') {
    await ack(ctx);
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

  await ack(ctx);
  const { text, keyboard } = await paywall();
  await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
}
