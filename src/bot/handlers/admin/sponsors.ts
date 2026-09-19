import { Composer, InlineKeyboard } from 'grammy';
import {
  countActiveChannels,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
  type SponsorChannel,
} from '../../../db/repositories/sponsors.js';
import { config } from '../../../lib/config.js';
import { endOfMskDay, escapeHtml, formatDate, parseMskDate } from '../../../lib/format.js';
import { logger } from '../../../lib/logger.js';
import type { Awaiting, BotContext } from '../../context.js';
import { admin, idsFrom, subFieldFrom, type ChannelField } from '../../keyboards/admin.js';
import { joinLink } from '../../keyboards/sponsor.js';

export const adminSponsors = new Composer<BotContext>();

const FIELDS: Record<ChannelField, { prompt: string; awaiting: Awaiting }> = {
  title: { prompt: 'Пришлите название канала — его увидят пользователи.', awaiting: 'sponsor_title' },
  link: {
    prompt:
      'Пришлите ссылку на канал (<code>https://t.me/...</code>) или <code>-</code>, чтобы убрать.',
    awaiting: 'sponsor_link',
  },
  starts: {
    prompt:
      'С какого числа канал в гейте? <code>01.10.2026</code>, или <code>-</code> — сразу.',
    awaiting: 'sponsor_starts',
  },
  ends: {
    prompt:
      'По какое число включительно? <code>01.11.2026</code>, или <code>-</code> — бессрочно.',
    awaiting: 'sponsor_ends',
  },
  target: {
    prompt: 'Сколько подписчиков обещано партнёру? Число или <code>-</code>.',
    awaiting: 'sponsor_target',
  },
};

// ─── Список каналов ──────────────────────────────────────────────────

adminSponsors.callbackQuery(admin.sponsors, async (ctx) => {
  await ctx.answerCallbackQuery();
  clear(ctx);
  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});

async function listScreen(): Promise<{ text: string; keyboard: InlineKeyboard }> {
  const channels = await listChannels();

  const kb = new InlineKeyboard();
  for (const channel of channels) {
    kb.text(`${channel.isActive ? '✅' : '🚫'} ${channel.title}`, admin.sponsor(channel.id)).row();
  }
  kb.text('‹ В админку', admin.panel);

  const head = ['📢 <b>Каналы спонсоров</b>', ''];
  const body =
    channels.length === 0
      ? [
          'Пока ни одного.',
          '',
          'Чтобы добавить канал, сделайте бота его администратором —',
          'он появится здесь сам. Без прав админа Telegram не отдаёт',
          'статус подписчика, и проверить подписку нечем.',
        ]
      : [
          `В гейте показываются первые ${config.SPONSOR_MAX_CHANNELS} включённых.`,
          '',
          ...channels.map(
            (c) =>
              `${c.isActive ? '✅' : '🚫'} ${escapeHtml(c.title)} — прошли ${c.joinedCount}` +
              (c.targetJoins ? ` из ${c.targetJoins}` : ''),
          ),
        ];

  return { text: [...head, ...body].join('\n'), keyboard: kb };
}

// ─── Карточка канала ─────────────────────────────────────────────────

adminSponsors.callbackQuery(/^a:sp1:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  clear(ctx);
  await renderCard(ctx, idsFrom(ctx.callbackQuery.data)[0]!);
});

async function renderCard(ctx: BotContext, id: number, fresh = false): Promise<void> {
  const channel = await getChannel(id);
  if (!channel) {
    const { text, keyboard } = await listScreen();
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return;
  }

  const link = joinLink(channel);
  const text = [
    `📢 <b>${escapeHtml(channel.title)}</b>`,
    '',
    `Статус: ${status(channel)}`,
    `Тип: ${channel.username ? `@${channel.username}` : 'приватный'}`,
    `Ссылка: ${link ? escapeHtml(link) : '— (нужны права «пригласительные ссылки»)'}`,
    `Размещение: ${period(channel)}`,
    `Прошли гейт: ${channel.joinedCount}${channel.targetJoins ? ` из ${channel.targetJoins}` : ''}`,
    `Добавлен: ${formatDate(channel.createdAt)}`,
    `chat_id: <code>${channel.chatId}</code>`,
  ].join('\n');

  const kb = new InlineKeyboard()
    .text('📝 Название', admin.sponsorField(id, 'title'))
    .text('🔗 Ссылка', admin.sponsorField(id, 'link'))
    .row()
    .text('📅 Начало', admin.sponsorField(id, 'starts'))
    .text('📅 Окончание', admin.sponsorField(id, 'ends'))
    .row()
    .text('🎯 План по подписчикам', admin.sponsorField(id, 'target'))
    .row()
    .text(channel.isActive ? '🚫 Убрать из гейта' : '✅ Включить в гейт', admin.sponsorToggle(id))
    .row()
    .text('🗑 Удалить', admin.sponsorDelete(id))
    .row()
    .text('‹ К списку', admin.sponsors);

  // После ввода значения правим не своё сообщение, а отвечаем новым.
  if (fresh) await ctx.reply(text, { parse_mode: 'HTML', reply_markup: kb });
  else await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: kb });
}

/** Включённый канал может всё равно не попадать в гейт — объясняем, почему. */
function status(channel: SponsorChannel): string {
  if (!channel.isActive) return 'выключен';

  const now = Date.now();
  if (channel.startsAt && channel.startsAt.getTime() > now) {
    return `ждёт начала размещения (${formatDate(channel.startsAt)})`;
  }
  if (channel.endsAt && channel.endsAt.getTime() <= now) return 'срок размещения истёк';
  if (!joinLink(channel)) return 'нет ссылки — подписаться невозможно';

  return 'в гейте';
}

function period(channel: SponsorChannel): string {
  const from = channel.startsAt ? `с ${formatDate(channel.startsAt)}` : 'сразу';
  // В базе лежит полночь следующих суток: срок указывают включительно.
  const to = channel.endsAt
    ? ` по ${formatDate(new Date(channel.endsAt.getTime() - 1))}`
    : ' бессрочно';
  return from + to;
}

// ─── Включение и выключение ──────────────────────────────────────────

adminSponsors.callbackQuery(/^a:sp2:\d+$/, async (ctx) => {
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const channel = await getChannel(id);

  if (!channel) {
    await ctx.answerCallbackQuery({ text: 'Канала больше нет', show_alert: true });
    return;
  }

  if (channel.isActive) {
    await updateChannel(id, { isActive: false });
    await ctx.answerCallbackQuery('Убрал из гейта');
    await renderCard(ctx, id);
    return;
  }

  if ((await countActiveChannels()) >= config.SPONSOR_MAX_CHANNELS) {
    await ctx.answerCallbackQuery({
      text: `Уже включено ${config.SPONSOR_MAX_CHANNELS} — больше люди не проходят. Выключите лишний.`,
      show_alert: true,
    });
    return;
  }

  const ready = await prepare(ctx, channel);
  if (!ready.ok) {
    await ctx.answerCallbackQuery({ text: ready.reason, show_alert: true });
    return;
  }

  await updateChannel(id, { isActive: true, inviteLink: ready.inviteLink ?? channel.inviteLink });
  await ctx.answerCallbackQuery('Канал в гейте');
  await renderCard(ctx, id);
});

/**
 * Проверяет, что каналом вообще можно пользоваться:
 * бот — администратор (иначе getChatMember не ответит) и есть ссылка,
 * по которой человек подпишется.
 */
async function prepare(
  ctx: BotContext,
  channel: SponsorChannel,
): Promise<{ ok: true; inviteLink?: string } | { ok: false; reason: string }> {
  try {
    const me = await ctx.api.getChatMember(channel.chatId, ctx.me.id);
    if (me.status !== 'administrator') {
      return { ok: false, reason: 'Бот не администратор канала — проверить подписку нечем.' };
    }
  } catch (err) {
    logger.warn({ err, channel: channel.chatId }, 'канал недоступен');
    return { ok: false, reason: 'Канал недоступен. Бот всё ещё в нём?' };
  }

  if (channel.username) return { ok: true };
  if (channel.inviteLink) return { ok: true, inviteLink: channel.inviteLink };

  // Приватный канал без ссылки: пробуем выписать свою.
  try {
    const link = await ctx.api.createChatInviteLink(channel.chatId, { name: 'Гейт бота' });
    return { ok: true, inviteLink: link.invite_link };
  } catch (err) {
    logger.warn({ err, channel: channel.chatId }, 'не смог создать инвайт-ссылку');
    return {
      ok: false,
      reason: 'Приватный канал без ссылки. Дайте боту право «Пригласительные ссылки».',
    };
  }
}

// ─── Поля канала ─────────────────────────────────────────────────────

adminSponsors.callbackQuery(/^a:spf:\d+:[a-z]+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const id = idsFrom(ctx.callbackQuery.data)[0]!;
  const field = subFieldFrom(ctx.callbackQuery.data) as ChannelField | undefined;
  if (!field || !(field in FIELDS)) return;

  ctx.session.awaiting = FIELDS[field].awaiting;
  ctx.session.editChannelId = id;
  await ctx.reply(FIELDS[field].prompt, { parse_mode: 'HTML' });
});

adminSponsors.on('message:text', async (ctx, next) => {
  const { awaiting, editChannelId } = ctx.session;
  if (!editChannelId) return next();

  const text = ctx.message.text.trim();
  const empty = text === '-';

  switch (awaiting) {
    case 'sponsor_title':
      return save(ctx, editChannelId, { title: text.slice(0, 80) });

    case 'sponsor_link': {
      if (empty) return save(ctx, editChannelId, { inviteLink: null });
      if (!/^https:\/\/t\.me\/\S+$/.test(text)) {
        await ctx.reply('Ссылка должна начинаться с https://t.me/');
        return;
      }
      return save(ctx, editChannelId, { inviteLink: text });
    }

    case 'sponsor_starts':
    case 'sponsor_ends': {
      if (empty) {
        return save(
          ctx,
          editChannelId,
          awaiting === 'sponsor_starts' ? { startsAt: null } : { endsAt: null },
        );
      }

      const date = parseMskDate(text);
      if (!date) {
        await ctx.reply('Не похоже на дату. Формат: <code>01.10.2026</code>.', {
          parse_mode: 'HTML',
        });
        return;
      }

      // Окончание храним как полночь следующих суток: «по 1 ноября»
      // означает, что весь первый день канал ещё работает.
      return save(
        ctx,
        editChannelId,
        awaiting === 'sponsor_starts' ? { startsAt: date } : { endsAt: endOfMskDay(date) },
      );
    }

    case 'sponsor_target': {
      if (empty) return save(ctx, editChannelId, { targetJoins: null });
      const target = Number(text);
      if (!Number.isInteger(target) || target < 1 || target > 10_000_000) {
        await ctx.reply('Нужно целое число или «-».');
        return;
      }
      return save(ctx, editChannelId, { targetJoins: target });
    }

    default:
      return next();
  }
});

async function save(
  ctx: BotContext,
  id: number,
  patch: Parameters<typeof updateChannel>[1],
): Promise<void> {
  await updateChannel(id, patch);
  clear(ctx);
  await renderCard(ctx, id, true);
}

/** Открыли другой экран — незавершённый ввод с прошлого забываем. */
function clear(ctx: BotContext): void {
  ctx.session.awaiting = undefined;
  ctx.session.editChannelId = undefined;
  ctx.session.editPlanId = undefined;
}

// ─── Удаление ────────────────────────────────────────────────────────

adminSponsors.callbackQuery(/^a:sp3:\d+$/, async (ctx) => {
  await deleteChannel(idsFrom(ctx.callbackQuery.data)[0]!);
  await ctx.answerCallbackQuery('Удалил');
  const { text, keyboard } = await listScreen();
  await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
});
