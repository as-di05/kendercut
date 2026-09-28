import { GrammyError } from 'grammy';
import type { InlineKeyboard } from 'grammy';
import { logger } from '../lib/logger.js';
import type { BotContext } from './context.js';

/**
 * Показывает экран на месте — правкой сообщения, с которого пришло нажатие.
 *
 * Голый editMessageText здесь не годится. Карточка фильма уходит фотографией,
 * а у фотографии нет текста: Telegram отвечает «there is no text in the message
 * to edit», обработчик падает, и кнопка «Назад» с виду просто зависает.
 * Поэтому нетекстовое сообщение убираем и шлём новое.
 */
export async function renderScreen(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const message = ctx.callbackQuery?.message;
  const options = { parse_mode: 'HTML' as const, reply_markup: keyboard };

  if (message && 'text' in message) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch (err) {
      // Тот же текст с теми же кнопками Telegram считает ошибкой, хотя
      // пользователь уже видит ровно то, что нужно.
      if (err instanceof GrammyError && err.description.includes('message is not modified')) return;
      logger.debug({ err }, 'правка сообщения не прошла, заменяю новым');
    }
  }

  if (message) {
    await ctx.api.deleteMessage(message.chat.id, message.message_id).catch(() => undefined);
  }

  await ctx.reply(text, options);
}
