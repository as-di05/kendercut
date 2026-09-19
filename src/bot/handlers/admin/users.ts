import { Composer, InlineKeyboard } from 'grammy';
import { listUserPayments } from '../../../db/repositories/payments.js';
import { referralStats } from '../../../db/repositories/referrals.js';
import {
  getActiveSubscription,
  grantSubscription,
} from '../../../db/repositories/subscriptions.js';
import { getUser, setBanned } from '../../../db/repositories/users.js';
import { escapeHtml, formatDate, plural } from '../../../lib/format.js';
import type { BotContext } from '../../context.js';
import { admin, idsFrom } from '../../keyboards/admin.js';

export const adminUsers = new Composer<BotContext>();

/** Карточка пользователя: /user 12345 */
adminUsers.command('user', async (ctx) => {
  const id = Number((ctx.match ?? '').trim());
  if (!Number.isSafeInteger(id) || id <= 0) {
    await ctx.reply('Формат: <code>/user 12345</code>', { parse_mode: 'HTML' });
    return;
  }
  await renderCard(ctx, id, true);
});

adminUsers.callbackQuery(/^a:u:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderCard(ctx, idsFrom(ctx.callbackQuery.data)[0]!);
});

async function renderCard(ctx: BotContext, id: number, fresh = false): Promise<void> {
  const user = await getUser(id);
  if (!user) {
    const message = 'Такого пользователя нет — он ещё не запускал бота.';
    if (fresh) await ctx.reply(message);
    else await ctx.editMessageText(message);
    return;
  }

  const [subscription, payments, referrals] = await Promise.all([
    getActiveSubscription(id),
    listUserPayments(id, 5),
    referralStats(id),
  ]);

  const paid = payments
    .filter((p) => p.status === 'paid')
    .reduce((sum, p) => sum + p.amount, 0);

  const text = [
    `👤 <b>${escapeHtml(user.firstName ?? 'Без имени')}</b>`,
    '',
    `ID: <code>${user.tgId}</code>`,
    user.username ? `Ник: @${escapeHtml(user.username)}` : undefined,
    `Пришёл: ${formatDate(user.createdAt)}`,
    `Заходил: ${formatDate(user.lastSeenAt)}`,
    user.referrerId ? `Пригласил: <code>${user.referrerId}</code>` : undefined,
    '',
    subscription
      ? `Подписка: до ${formatDate(subscription.expiresAt)}`
      : 'Подписка: нет',
    `Оплатил: ${paid} ⭐`,
    `Привёл людей: ${referrals.invited}`,
    user.isBanned ? '' : undefined,
    user.isBanned ? '🚫 <b>Заблокирован</b>' : undefined,
  ].filter((line) => line !== undefined);

  const kb = new InlineKeyboard()
    .text('➕ 30 дней', admin.userGrant(id))
    .row()
    .text(user.isBanned ? '✅ Разблокировать' : '🚫 Заблокировать', admin.userBan(id))
    .row()
    .text('🔄 Обновить', admin.user(id));

  const payload = { parse_mode: 'HTML' as const, reply_markup: kb };
  if (fresh) await ctx.reply(text.join('\n'), payload);
  else await ctx.editMessageText(text.join('\n'), payload);
}

adminUsers.callbackQuery(/^a:ub:\d+$/, async (ctx) => {
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const user = await getUser(id);
  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });
    return;
  }

  await setBanned(id, !user.isBanned);
  await ctx.answerCallbackQuery(user.isBanned ? 'Разблокирован' : 'Заблокирован');
  await renderCard(ctx, id);
});

adminUsers.callbackQuery(/^a:ug:\d+$/, async (ctx) => {
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  if (!(await getUser(id))) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден', show_alert: true });
    return;
  }

  const subscription = await grantSubscription({ userId: id, days: 30, source: 'admin' });
  await ctx.answerCallbackQuery(`До ${formatDate(subscription.expiresAt)}`);
  await renderCard(ctx, id);

  await ctx.api
    .sendMessage(id, `Вам начислено ${plural(30, 'день', 'дня', 'дней')} подписки.`)
    .catch(() => undefined);
});
