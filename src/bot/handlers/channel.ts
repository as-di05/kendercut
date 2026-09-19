import { Composer, InlineKeyboard } from 'grammy';
import type { Message } from 'grammy/types';
import { createDraft } from '../../db/repositories/films.js';
import { config } from '../../lib/config.js';
import { escapeHtml } from '../../lib/format.js';
import { logger } from '../../lib/logger.js';
import type { BotContext } from '../context.js';
import { admin } from '../keyboards/admin.js';

export const channelHandler = new Composer<BotContext>();

/**
 * Приём фильмов из канала-хранилища.
 *
 * Заливать файл должен обычный аккаунт (боту доступны только 50 МБ), а бот,
 * будучи админом канала, ловит пост и запоминает координаты сообщения.
 * Именно chat_id + message_id, а не file_id: по ним потом работает
 * copyMessage, который не ломается при протухании file_id.
 */
channelHandler.on('channel_post', async (ctx) => {
  const chatId = ctx.chat.id;
  if (chatId !== config.STORAGE_CHANNEL_ID) return;

  const video = extractVideo(ctx.channelPost);
  if (!video) return;

  const caption = ctx.channelPost.caption?.trim();
  const { film, isNew } = await createDraft({
    storageChatId: chatId,
    storageMessageId: ctx.channelPost.message_id,
    fileId: video.file_id,
    fileUniqueId: video.file_unique_id,
    fileSize: video.file_size,
    durationMin: video.duration ? Math.round(video.duration / 60) : undefined,
    // Подпись к посту часто уже содержит название — берём как заготовку.
    titleRu: caption || 'Без названия',
  });

  logger.info(
    { film: film.id, isNew, message: ctx.channelPost.message_id },
    isNew ? 'новый файл из канала' : 'файл уже был в каталоге',
  );

  await notifyAdmins(ctx, film.id, film.titleRu, isNew, video);
});

/**
 * Общее у video и document: у документа нет ни размеров кадра, ни длительности,
 * поэтому берём только то, что есть у обоих.
 */
type StoredMedia = {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  duration?: number;
};

/** Фильм может прийти и документом — например, mkv, который Telegram не распознал как видео. */
function extractVideo(post: Message): StoredMedia | undefined {
  if (post.video) return post.video;
  if (post.document?.mime_type?.startsWith('video/')) return post.document;
  return undefined;
}

async function notifyAdmins(
  ctx: BotContext,
  filmId: number,
  title: string,
  isNew: boolean,
  video: StoredMedia,
): Promise<void> {
  const size = video.file_size ? `${(video.file_size / 1024 ** 3).toFixed(2)} ГБ` : 'размер неизвестен';
  const duration = video.duration ? `${Math.round(video.duration / 60)} мин` : 'длительность неизвестна';

  const text = isNew
    ? [
        '📥 <b>Новый файл в хранилище</b>',
        '',
        `Подпись: ${escapeHtml(title)}`,
        `${size} · ${duration}`,
        '',
        'Оформим карточку?',
      ].join('\n')
    : [
        '⚠️ <b>Этот файл уже есть в каталоге</b>',
        '',
        `Он привязан к фильму «${escapeHtml(title)}».`,
        'Повторную заливку из канала можно удалить.',
      ].join('\n');

  const keyboard = isNew
    ? new InlineKeyboard().text('Оформить', admin.fill(filmId)).text('Удалить', admin.confirmDelete(filmId))
    : new InlineKeyboard().text('Открыть карточку', admin.card(filmId));

  for (const adminId of config.ADMIN_IDS) {
    await ctx.api
      .sendMessage(adminId, text, { parse_mode: 'HTML', reply_markup: keyboard })
      .catch((err) => logger.warn({ adminId, err }, 'не смог уведомить админа'));
  }
}
