import { Composer, InlineKeyboard } from 'grammy';
import { referralStats } from '../../db/repositories/referrals.js';
import { config } from '../../lib/config.js';
import { plural } from '../../lib/format.js';
import type { BotContext } from '../context.js';
import { nav } from '../keyboards/main.js';

export const inviteHandler = new Composer<BotContext>();

inviteHandler.callbackQuery(nav.invite, async (ctx) => {
  await ctx.answerCallbackQuery();

  const link = inviteLink(ctx.me.username, ctx.user.tgId);
  const stats = await referralStats(ctx.user.tgId);
  const days = config.REFERRAL_BONUS_DAYS;

  const lines =
    days === 0
      ? ['🎁 <b>Приглашения</b>', '', 'Бонусы за приглашения сейчас отключены.']
      : [
          '🎁 <b>Пригласите друга</b>',
          '',
          `Оба получаете по ${plural(days, 'день', 'дня', 'дней')} подписки,`,
          'когда друг посмотрит свой первый фильм.',
          '',
          `Ваша ссылка:\n<code>${link}</code>`,
          '',
          `Пришло по ссылке: ${stats.invited}`,
          `Начислено: ${plural(stats.days, 'день', 'дня', 'дней')}`,
        ];

  const kb = new InlineKeyboard();
  if (days > 0) kb.url('📤 Поделиться', shareLink(link)).row();
  kb.text('‹ В меню', nav.home);

  await ctx.editMessageText(lines.join('\n'), { parse_mode: 'HTML', reply_markup: kb });
});

const inviteLink = (botUsername: string, userId: number): string =>
  `https://t.me/${botUsername}?start=ref_${userId}`;

/** Штатный телеграмный «поделиться»: открывает выбор чата с готовым текстом. */
function shareLink(link: string): string {
  const text = 'Смотрю фильмы тут — заходи, первый фильм бесплатно.';
  return `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
}
