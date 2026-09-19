import { Composer, InlineKeyboard } from 'grammy';
import { listActivePlans, type Plan } from '../../db/repositories/catalog.js';
import { getActiveSubscription } from '../../db/repositories/subscriptions.js';
import { formatDate, plural } from '../../lib/format.js';
import { supportsAutoRenew } from '../../services/payments.js';
import type { BotContext } from '../context.js';
import { nav } from '../keyboards/main.js';

export const subscriptionHandler = new Composer<BotContext>();

export const sub = {
  buy: (planId: number) => `s:buy:${planId}`,
  auto: (planId: number) => `s:auto:${planId}`,
  screen: 'nav:subscription',
} as const;

/** Кнопки тарифов. Автопродление показываем только там, где Telegram его позволяет. */
function planButtons(plans: Plan[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const plan of plans) {
    kb.text(`${plan.title} — ${plan.priceStars} ⭐`, sub.buy(plan.id)).row();
    if (supportsAutoRenew(plan)) {
      kb.text(`🔄 ${plan.title} с автопродлением`, sub.auto(plan.id)).row();
    }
  }
  return kb;
}

subscriptionHandler.callbackQuery(nav.subscription, async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, keyboard } = await subscriptionScreen(ctx.user.tgId);
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

/** Экран подписки: текущий статус плюс тарифы. */
export async function subscriptionScreen(
  userId: number,
): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const [current, plans] = await Promise.all([getActiveSubscription(userId), listActivePlans()]);

  const lines = ['⭐ <b>Подписка</b>', ''];

  if (current) {
    const daysLeft = Math.ceil((current.expiresAt.getTime() - Date.now()) / 86_400_000);
    lines.push(
      `Активна до ${formatDate(current.expiresAt)}`,
      `Осталось ${plural(daysLeft, 'день', 'дня', 'дней')}.`,
      '',
      'Можно продлить заранее — новый срок прибавится к текущему.',
    );
  } else {
    lines.push('С подпиской открыт весь каталог без ограничений.', '', 'Выберите тариф:');
  }

  const kb = planButtons(plans).text('‹ В меню', nav.home);

  return { text: lines.join('\n'), keyboard: kb };
}

/** Пейволл: тарифы плюс объяснение, почему сюда попали. */
export async function paywall(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const plans = await listActivePlans();

  const kb = planButtons(plans).text('‹ В каталог', nav.catalog);

  return {
    text: [
      '🔒 <b>Нужна подписка</b>',
      '',
      'Просмотр фильмов доступен по подписке.',
      '',
      'Выберите тариф:',
    ].join('\n'),
    keyboard: kb,
  };
}
