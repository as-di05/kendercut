import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import { listDueDeletions, markDeleted } from '../db/repositories/delivery.js';
import { logger } from '../lib/logger.js';
/**
 * Удаляет выданные фильмы, когда истёк их срок.
 *
 * Очередь живёт в таблице, а не в памяти: после перезапуска бота сообщения
 * всё равно исчезнут. Раз в минуту забираем всё, чему пора.
 */
/** Один проход очереди. Возвращает, сколько сообщений обработано. */
export async function sweepDeletions(api: Api): Promise<number> {
  const due = await listDueDeletions();

  for (const message of due) {
    try {
      await api.deleteMessage(message.chatId, message.messageId);
    } catch (err) {
      // Пользователь мог удалить сообщение сам, или прошло больше 48 часов —
      // в обоих случаях делать больше нечего, помечаем и идём дальше.
      const description = err instanceof GrammyError ? err.description : String(err);
      logger.debug({ message: message.id, description }, 'сообщение уже недоступно');
    }
    await markDeleted(message.id);
  }

  if (due.length > 0) logger.info({ count: due.length }, 'выданные сообщения удалены');
  return due.length;
}
