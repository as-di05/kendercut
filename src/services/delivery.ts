import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import { recordView, scheduleDeletion } from '../db/repositories/delivery.js';
import type { FilmCard } from '../db/repositories/films.js';
import { config } from '../lib/config.js';
import { escapeHtml } from '../lib/format.js';
import { logger } from '../lib/logger.js';

export type DeliveryResult =
  | { ok: true; messageId: number }
  | { ok: false; reason: 'file_missing' };

/**
 * Отдаёт фильм пользователю.
 *
 * Основной путь — copyMessage по координатам поста в канале-хранилище:
 * копия не помечена как пересланная, подпись можно подменить своей,
 * и она не зависит от того, протух ли file_id.
 * Если пост в канале удалили, откатываемся на сохранённый file_id.
 */
export async function deliverFilm(
  api: Api,
  userId: number,
  film: FilmCard,
): Promise<DeliveryResult> {
  const caption = buildCaption(film);
  const options = {
    caption,
    parse_mode: 'HTML' as const,
    // Запрещает пересылку и сохранение в галерею.
    protect_content: true,
  };

  let messageId: number | undefined;

  try {
    const copied = await api.copyMessage(userId, film.storageChatId, film.storageMessageId, options);
    messageId = copied.message_id;
  } catch (err) {
    logger.warn(
      { film: film.id, err: err instanceof GrammyError ? err.description : err },
      'copyMessage не удался, пробую file_id',
    );

    if (!film.fileId) return { ok: false, reason: 'file_missing' };

    try {
      const sent = await api.sendVideo(userId, film.fileId, options);
      messageId = sent.message_id;
    } catch (fallbackErr) {
      logger.error({ film: film.id, err: fallbackErr }, 'файл не удалось отдать ни одним способом');
      return { ok: false, reason: 'file_missing' };
    }
  }

  await recordView(userId, film.id);

  const deleteAt = new Date(Date.now() + config.AUTO_DELETE_MINUTES * 60_000);
  await scheduleDeletion(userId, userId, messageId, deleteAt);

  return { ok: true, messageId };
}

/** Про автоудаление намеренно молчим: предупреждение только подталкивает скачать. */
function buildCaption(film: FilmCard): string {
  const meta = [
    film.year ? String(film.year) : undefined,
    film.durationMin ? `${film.durationMin} мин` : undefined,
  ].filter(Boolean);

  return [`<b>${escapeHtml(film.titleRu)}</b>`, meta.length ? meta.join(' · ') : undefined]
    .filter((line) => line !== undefined)
    .join('\n');
}
