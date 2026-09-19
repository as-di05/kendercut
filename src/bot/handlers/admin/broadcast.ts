import { Composer, InlineKeyboard } from 'grammy';
import {
  countAudience,
  createBroadcast,
  deleteBroadcast,
  getBroadcast,
  listBroadcasts,
  segmentOf,
  updateBroadcast,
  SEGMENT_TITLES,
  type Broadcast,
  type Segment,
} from '../../../db/repositories/broadcasts.js';
import { escapeHtml, formatDate } from '../../../lib/format.js';
import { startBroadcast } from '../../../services/broadcast.js';
import type { BotContext } from '../../context.js';
import { admin, idsFrom } from '../../keyboards/admin.js';

export const adminBroadcast = new Composer<BotContext>();

// ─── Список ──────────────────────────────────────────────────────────

adminBroadcast.callbackQuery(admin.broadcasts, async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.awaiting = undefined;
  ctx.session.broadcastSegment = undefined;

  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

async function listScreen(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const recent = await listBroadcasts(5);

  const kb = new InlineKeyboard();
  for (const item of recent) {
    kb.text(`${icon(item)} ${preview(item.text)} · ${item.sent}`, admin.broadcast(item.id)).row();
  }
  kb.text('📣 Всем', admin.broadcastNew('all'))
    .row()
    .text('⭐ С подпиской', admin.broadcastNew('subscribers'))
    .text('🕓 Без подписки', admin.broadcastNew('no_subscription'))
    .row()
    .text('‹ В админку', admin.panel);

  return {
    text: [
      '📣 <b>Рассылка</b>',
      '',
      'Выберите, кому писать. Текст с HTML-разметкой — как в сообщениях бота.',
      '',
      'Забаненные не получают рассылку никогда.',
    ].join('\n'),
    keyboard: kb,
  };
}

// ─── Новая рассылка ──────────────────────────────────────────────────

adminBroadcast.callbackQuery(/^a:bc\+:[a-z_]+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const segment = (ctx.callbackQuery.data.split(':')[2] ?? 'all') as Segment;

  ctx.session.awaiting = 'broadcast_text';
  ctx.session.broadcastSegment = segment;

  const audience = await countAudience(segment);
  await ctx.reply(
    [
      `Получателей: <b>${audience}</b> (${SEGMENT_TITLES[segment]}).`,
      '',
      'Пришлите текст рассылки.',
    ].join('\n'),
    { parse_mode: 'HTML' },
  );
});

adminBroadcast.on('message:text', async (ctx, next) => {
  const { awaiting, broadcastSegment } = ctx.session;
  if (awaiting !== 'broadcast_text' || !broadcastSegment) return next();

  const broadcast = await createBroadcast(ctx.message.text, broadcastSegment);
  ctx.session.awaiting = undefined;
  ctx.session.broadcastSegment = undefined;

  await renderCard(ctx, broadcast.id, true);
});

// ─── Карточка ────────────────────────────────────────────────────────

adminBroadcast.callbackQuery(/^a:bc1:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderCard(ctx, idsFrom(ctx.callbackQuery.data)[0]!);
});

async function renderCard(ctx: BotContext, id: number, fresh = false): Promise<void> {
  const broadcast = await getBroadcast(id);
  if (!broadcast) {
    const { text, keyboard } = await listScreen();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  const segment = segmentOf(broadcast);
  const audience = broadcast.status === 'draft' ? await countAudience(segment) : broadcast.total;

  const lines = [
    `📣 <b>Рассылка №${broadcast.id}</b>`,
    '',
    `Кому: ${SEGMENT_TITLES[segment]} — ${audience}`,
    `Статус: ${statusText(broadcast)}`,
    broadcast.status === 'draft' ? undefined : `Отправлено: ${broadcast.sent}, не дошло: ${broadcast.failed}`,
    `Создана: ${formatDate(broadcast.createdAt)}`,
    '',
    '— — —',
    broadcast.text,
  ].filter((line) => line !== undefined);

  const kb = new InlineKeyboard();
  if (broadcast.status === 'draft') {
    kb.text('🚀 Отправить', admin.broadcastSend(id))
      .text('🗑 Удалить', admin.broadcastDrop(id))
      .row();
  }
  if (broadcast.status === 'running') {
    kb.text('⏹ Остановить', admin.broadcastStop(id))
      .text('🔄 Обновить', admin.broadcast(id))
      .row();
  }
  kb.text('‹ К рассылкам', admin.broadcasts);

  // Текст рассылки показываем как есть: HTML в нём — авторский, и админ
  // должен увидеть ровно то, что получат люди.
  const payload = { parse_mode: 'HTML' as const, reply_markup: kb };
  if (fresh) await ctx.reply(lines.join('\n'), payload);
  else await ctx.editMessageText(lines.join('\n'), payload);
}

// ─── Запуск и остановка ──────────────────────────────────────────────

adminBroadcast.callbackQuery(/^a:bc2:\d+$/, async (ctx) => {
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const broadcast = await getBroadcast(id);

  if (broadcast?.status !== 'draft') {
    await ctx.answerCallbackQuery({ text: 'Эта рассылка уже запускалась.', show_alert: true });
    return;
  }

  // Статус ставим здесь, а не внутри задачи: пока она раскачается, админ
  // успеет нажать «Отправить» второй раз.
  await updateBroadcast(id, { status: 'running' });
  startBroadcast(ctx.api, id);

  await ctx.answerCallbackQuery('Пошла');
  await renderCard(ctx, id);
});

adminBroadcast.callbackQuery(/^a:bc3:\d+$/, async (ctx) => {
  await updateBroadcast(idsFrom(ctx.callbackQuery.data)[0]!, {
    status: 'cancelled',
    finishedAt: new Date(),
  });
  await ctx.answerCallbackQuery('Остановил');
  await renderCard(ctx, idsFrom(ctx.callbackQuery.data)[0]!);
});

adminBroadcast.callbackQuery(/^a:bc4:\d+$/, async (ctx) => {
  await deleteBroadcast(idsFrom(ctx.callbackQuery.data)[0]!);
  await ctx.answerCallbackQuery('Удалил');
  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

const icon = (broadcast: Broadcast): string =>
  ({ draft: '📝', running: '🚀', done: '✅', cancelled: '⏹' })[broadcast.status];

const statusText = (broadcast: Broadcast): string =>
  ({
    draft: 'черновик, ещё не отправлена',
    running: 'идёт',
    done: 'отправлена',
    cancelled: 'остановлена',
  })[broadcast.status];

const preview = (text: string): string => {
  const flat = escapeHtml(text).replace(/\s+/g, ' ');
  return flat.length <= 24 ? flat : `${flat.slice(0, 23)}…`;
};
