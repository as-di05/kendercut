import { Composer, InlineKeyboard } from 'grammy';
import {
  createPlan,
  deletePlan,
  getPlanByCode,
  listPlans,
  updatePlan,
} from '../../../db/repositories/catalog.js';
import { escapeHtml, plural } from '../../../lib/format.js';
import { supportsAutoRenew } from '../../../services/payments.js';
import type { Awaiting, BotContext } from '../../context.js';
import { admin, idsFrom, subFieldFrom, type PlanField } from '../../keyboards/admin.js';

export const adminPlans = new Composer<BotContext>();

const FIELDS: Record<PlanField, { prompt: string; awaiting: Awaiting }> = {
  title: {
    prompt: 'Пришлите название тарифа, например <code>Месяц</code>.',
    awaiting: 'plan_title',
  },
  price: { prompt: 'Пришлите цену в звёздах, например <code>299</code>.', awaiting: 'plan_price' },
  days: { prompt: 'Пришлите срок в днях, например <code>30</code>.', awaiting: 'plan_days' },
};

// ─── Список ──────────────────────────────────────────────────────────

adminPlans.callbackQuery(admin.plans, async (ctx) => {
  await ctx.answerCallbackQuery();
  clear(ctx);
  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

async function listScreen(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const plans = await listPlans();

  const kb = new InlineKeyboard();
  for (const plan of plans) {
    kb.text(
      `${plan.isActive ? '✅' : '🚫'} ${plan.title} — ${plan.priceStars} ⭐`,
      admin.plan(plan.id),
    ).row();
  }
  kb.text('➕ Новый тариф', admin.planNew).row().text('‹ В админку', admin.panel);

  return {
    text: [
      '⭐ <b>Тарифы</b>',
      '',
      plans.length === 0
        ? 'Пока ни одного. Без тарифов купить подписку нельзя.'
        : 'Выключенный тариф не показывается пользователям, но оплаченные по нему подписки продолжают работать.',
    ].join('\n'),
    keyboard: kb,
  };
}

// ─── Карточка ────────────────────────────────────────────────────────

adminPlans.callbackQuery(/^a:pl1:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  clear(ctx);
  await renderCard(ctx, idsFrom(ctx.callbackQuery.data)[0]!);
});

async function renderCard(ctx: BotContext, id: number, fresh = false): Promise<void> {
  const plan = (await listPlans()).find((p) => p.id === id);
  if (!plan) {
    const { text, keyboard } = await listScreen();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  const text = [
    `⭐ <b>${escapeHtml(plan.title)}</b>`,
    '',
    `Цена: ${plan.priceStars} ⭐`,
    `Срок: ${plural(plan.days, 'день', 'дня', 'дней')}`,
    `Статус: ${plan.isActive ? 'продаётся' : 'выключен'}`,
    supportsAutoRenew(plan)
      ? 'Продаётся и с автопродлением — Telegram разрешает его только на 30 днях.'
      : undefined,
    `code: <code>${plan.code}</code>`,
  ]
    .filter((line) => line !== undefined)
    .join('\n');

  const kb = new InlineKeyboard()
    .text('💰 Цена', admin.planField(id, 'price'))
    .text('📅 Срок', admin.planField(id, 'days'))
    .row()
    .text('📝 Название', admin.planField(id, 'title'))
    .row()
    .text(plan.isActive ? '🚫 Снять с продажи' : '✅ Продавать', admin.planToggle(id))
    .row()
    .text('🗑 Удалить', admin.planDelete(id))
    .row()
    .text('‹ К тарифам', admin.plans);

  // После ввода значения экран приходится слать заново: правим-то мы
  // сообщение админа, а не своё.
  if (fresh) await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  else await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
}

// ─── Поля ────────────────────────────────────────────────────────────

adminPlans.callbackQuery(/^a:plf:\d+:[a-z]+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const field = subFieldFrom(ctx.callbackQuery.data) as PlanField | undefined;
  if (!field || !(field in FIELDS)) return;

  ctx.session.awaiting = FIELDS[field].awaiting;
  ctx.session.editPlanId = id;
  await ctx.reply(FIELDS[field].prompt, { parse_mode: 'HTML' });
});

adminPlans.callbackQuery(admin.planNew, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = 'plan_new';
  ctx.session.editPlanId = undefined;
  await ctx.reply(
    [
      'Пришлите срок и цену через пробел: <code>30 299</code>',
      '',
      '— 30 дней, 299 звёзд. Название и продажу включите потом.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});

adminPlans.on('message:text', async (ctx, next) => {
  const { awaiting, editPlanId } = ctx.session;
  const text = ctx.message.text.trim();

  if (awaiting === 'plan_new') return addPlan(ctx, text);
  if (!editPlanId) return next();

  switch (awaiting) {
    case 'plan_title':
      return save(ctx, editPlanId, { title: text.slice(0, 40) });
    case 'plan_price':
      return saveNumber(ctx, editPlanId, text, 'price');
    case 'plan_days':
      return saveNumber(ctx, editPlanId, text, 'days');
    default:
      return next();
  }
});

async function save(
  ctx: BotContext,
  id: number,
  patch: Parameters<typeof updatePlan>[1],
): Promise<void> {
  await updatePlan(id, patch);
  clear(ctx);
  await renderCard(ctx, id, true);
}

async function saveNumber(
  ctx: BotContext,
  id: number,
  text: string,
  kind: 'price' | 'days',
): Promise<void> {
  const value = Number(text);
  const limit = kind === 'price' ? 100_000 : 3650;

  if (!Number.isInteger(value) || value < 1 || value > limit) {
    await ctx.reply(`Нужно целое число от 1 до ${limit}.`);
    return;
  }

  return save(ctx, id, kind === 'price' ? { priceStars: value } : { days: value, sort: value });
}

async function addPlan(ctx: BotContext, text: string): Promise<void> {
  const [daysRaw, priceRaw] = text.split(/\s+/);
  const days = Number(daysRaw);
  const price = Number(priceRaw);

  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    await ctx.reply('Первое число — срок в днях, от 1 до 3650.');
    return;
  }
  if (!Number.isInteger(price) || price < 1 || price > 100_000) {
    await ctx.reply('Второе число — цена в звёздах, от 1 до 100000.');
    return;
  }

  // code уникален и нигде не показывается — генерируем сами, чтобы не спрашивать.
  let code = `d${days}`;
  for (let n = 2; await getPlanByCode(code); n++) code = `d${days}_${n}`;

  const plan = await createPlan({
    code,
    title: plural(days, 'день', 'дня', 'дней'),
    days,
    priceStars: price,
  });

  clear(ctx);
  await ctx.reply('Тариф создан и пока не продаётся — проверьте и включите.');
  await renderCard(ctx, plan.id, true);
}

// ─── Включение и удаление ────────────────────────────────────────────

adminPlans.callbackQuery(/^a:pl2:\d+$/, async (ctx) => {
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const plan = (await listPlans()).find((p) => p.id === id);
  if (!plan) {
    await ctx.answerCallbackQuery({ text: 'Тарифа больше нет', show_alert: true });
    return;
  }

  await updatePlan(id, { isActive: !plan.isActive });
  await ctx.answerCallbackQuery(plan.isActive ? 'Снял с продажи' : 'Продаётся');
  await renderCard(ctx, id);
});

adminPlans.callbackQuery(/^a:pl3:\d+$/, async (ctx) => {
  // Подписки и платежи по удалённому тарифу остаются: ссылка на план
  // обнуляется, срок и деньги никуда не деваются.
  await deletePlan(idsFrom(ctx.callbackQuery.data)[0]!);
  await ctx.answerCallbackQuery('Удалил');
  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

/** Открыли другой экран — незавершённый ввод с прошлого забываем. */
function clear(ctx: BotContext): void {
  ctx.session.awaiting = undefined;
  ctx.session.editPlanId = undefined;
  ctx.session.editChannelId = undefined;
}
