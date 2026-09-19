import { Composer } from 'grammy';
import { getActiveSubscription } from '../../db/repositories/subscriptions.js';
import { escapeHtml, formatDate, plural } from '../../lib/format.js';
import type { BotContext } from '../context.js';
import { backToMenu, nav } from '../keyboards/main.js';

export const menuHandler = new Composer<BotContext>();

menuHandler.callbackQuery(nav.profile, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(await profileText(ctx), {
    parse_mode: 'HTML',
    reply_markup: backToMenu,
  });
});

async function profileText(ctx: BotContext): Promise<string> {
  const { user } = ctx;
  const subscription = await getActiveSubscription(user.tgId);

  const lines = [
    '👤 <b>Профиль</b>',
    '',
    `ID: <code>${user.tgId}</code>`,
    user.firstName ? `Имя: ${escapeHtml(user.firstName)}` : undefined,
    `С нами с: ${formatDate(user.createdAt)}`,
  ];

  if (subscription) {
    const daysLeft = Math.ceil((subscription.expiresAt.getTime() - Date.now()) / 86_400_000);
    lines.push(
      `Подписка: активна до ${formatDate(subscription.expiresAt)}`,
      `Осталось: ${plural(daysLeft, 'день', 'дня', 'дней')}`,
    );
  } else {
    lines.push('Подписка: нет');
  }

  if (ctx.isAdmin) lines.push('', '🛠 Права администратора');

  return lines.filter(Boolean).join('\n');
}
