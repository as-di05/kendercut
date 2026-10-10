import { Composer, InlineKeyboard } from 'grammy';
import { getChannelByChatId, updateChannel, upsertChannel } from '../../db/repositories/sponsors.js';
import { config } from '../../lib/config.js';
import { escapeHtml } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import { checkAccess } from '../../services/access.js';
import { forgetGateResult, rememberJoinRequest } from '../../services/sponsor-gate.js';
import type { BotContext } from '../context.js';
import { admin } from '../keyboards/admin.js';
import { missingText } from '../keyboards/sponsor.js';
import { openFilmCard } from './catalog.js';
import { serveFilm } from './watch.js';

export const sponsorHandler = new Composer<BotContext>();

// ─── «Проверить» ─────────────────────────────────────────────────────

sponsorHandler.callbackQuery(/^g:c:(\d+)$/, async (ctx) => {
  // Человек только что подписался — ждать, пока протухнет кэш, незачем.
  await forgetGateResult(ctx.user.tgId);
  await serveFilm(ctx, Number(ctx.match[1]), { fromGateCheck: true });
});

/**
 * То же «Проверить», но для пришедших по коду: карточку они ещё не видели,
 * и наградой за подписку должна стать именно она — название, описание,
 * постер. Файл человек заберёт уже кнопкой «Смотреть», если он есть.
 */
sponsorHandler.callbackQuery(/^g:r:(\d+)$/, async (ctx) => {
  const filmId = Number(ctx.match[1]);
  await forgetGateResult(ctx.user.tgId);

  const access = await checkAccess(ctx.api, ctx.user.tgId, ctx.isAdmin);
  if (!access.allowed && access.reason === 'sponsor_required') {
    await ctx.answerCallbackQuery({ text: missingText(access.missing), show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();
  if (!(await openFilmCard(ctx, filmId))) {
    await ctx.reply('Этот фильм больше недоступен.');
  }
});

// ─── Заявки в приватные каналы ───────────────────────────────────────

/**
 * Пока заявку не одобрили, getChatMember отвечает «left», и человек
 * не пройдёт гейт, хотя сделал всё, что от него требовалось.
 * Поэтому саму заявку считаем выполненным условием.
 */
sponsorHandler.on('chat_join_request', async (ctx) => {
  const chatId = ctx.chatJoinRequest.chat.id;
  if (!(await getChannelByChatId(chatId))) return;

  await rememberJoinRequest(ctx.chatJoinRequest.from.id, chatId);
  logger.info({ user: ctx.chatJoinRequest.from.id, channel: chatId }, 'заявка в канал спонсора');
});

// ─── Регистрация канала ──────────────────────────────────────────────

/**
 * Бота сделали админом в чужом канале — это и есть добавление спонсора.
 * Отдельной команды нет намеренно: без прав администратора канал всё равно
 * бесполезен, а значит добавлять его руками некуда.
 */
sponsorHandler.on('my_chat_member', async (ctx) => {
  const { chat, new_chat_member: status } = ctx.myChatMember;
  if (chat.type !== 'channel') return;
  if (chat.id === config.STORAGE_CHANNEL_ID) return;

  if (status.status === 'administrator') {
    const { channel, isNew } = await upsertChannel({
      chatId: chat.id,
      title: chat.title,
      username: chat.username,
    });

    if (!isNew) return;

    logger.info({ channel: chat.id, title: chat.title }, 'новый канал-кандидат в спонсоры');
    await notifyAdmins(
      ctx,
      [
        '📢 <b>Бота сделали админом в канале</b>',
        '',
        escapeHtml(chat.title),
        chat.username ? `@${chat.username}` : 'приватный канал',
        '',
        'Включить его в гейт?',
      ].join('\n'),
      new InlineKeyboard()
        .text('✅ Включить', admin.sponsorToggle(channel.id))
        .text('Открыть', admin.sponsor(channel.id)),
    );
    return;
  }

  // Права сняли или бота выгнали: проверять подписку больше нечем.
  const known = await getChannelByChatId(chat.id);
  if (!known?.isActive) return;

  await updateChannel(known.id, { isActive: false });
  logger.warn({ channel: chat.id }, 'канал выключен: бот больше не админ');
  await notifyAdmins(
    ctx,
    [
      '⚠️ <b>Канал выключен</b>',
      '',
      `Бот больше не администратор в «${escapeHtml(known.title)}»,`,
      'проверить подписку невозможно. Канал убран из гейта.',
    ].join('\n'),
    new InlineKeyboard().text('Открыть', admin.sponsor(known.id)),
  );
});

async function notifyAdmins(
  ctx: BotContext,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  for (const adminId of config.ADMIN_IDS) {
    await ctx.api
      .sendMessage(adminId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch((err) => logger.warn({ adminId, err }, 'не смог уведомить админа'));
  }
}
