import type { Api } from 'grammy';
import { GrammyError, InlineKeyboard } from 'grammy';
import {
  expireSubscriptions,
  listExpiringSoon,
  markReminded,
  type Subscription,
} from '../db/repositories/subscriptions.js';
import { formatDate, plural } from '../lib/format.js';
import { logger } from '../lib/logger.js';
import { nav } from '../bot/keyboards/main.js';

/**
 * За сколько суток предупреждаем.
 * Порядок по возрастанию важен: берём самый узкий порог, в который попадает
 * остаток. Иначе человеку с половиной суток достался бы порог «3 дня»,
 * и второе напоминание он бы не получил.
 */
const THRESHOLDS = [1, 3] as const;
const WIDEST_THRESHOLD = Math.max(...THRESHOLDS);

/** Пауза между сообщениями: Telegram пропускает около 30 в секунду. */
const SEND_GAP_MS = 50;

const renewKeyboard = (): InlineKeyboard =>
  new InlineKeyboard().text('⭐ Продлить подписку', nav.subscription);

/**
 * Закрывает истёкшие подписки и сообщает об этом людям.
 * Доступ они не дают и так, но без снятого флага статистика и рассылки врут.
 */
export async function sweepExpired(api: Api): Promise<number> {
  const expired = await expireSubscriptions();

  for (const subscription of expired) {
    await notify(
      api,
      subscription.userId,
      [
        '⌛ <b>Подписка закончилась</b>',
        '',
        'Каталог остался, доступ к просмотру — нет.',
        'Продлить можно в любой момент.',
      ].join('\n'),
    );
  }

  if (expired.length > 0) logger.info({ count: expired.length }, 'подписки закрыты по сроку');
  return expired.length;
}

/**
 * Напоминает тем, у кого подписка на исходе.
 * Каждый порог срабатывает один раз: отправленный записывается в саму подписку,
 * поэтому повторный проход через час ничего не продублирует.
 */
export async function sweepReminders(api: Api): Promise<number> {
  const soon = await listExpiringSoon(WIDEST_THRESHOLD);
  let sent = 0;

  for (const subscription of soon) {
    const threshold = bucketFor(subscription);
    if (threshold === undefined) continue;

    const daysLeft = Math.ceil((subscription.expiresAt.getTime() - Date.now()) / 86_400_000);
    await notify(
      api,
      subscription.userId,
      [
        '⏳ <b>Подписка скоро закончится</b>',
        '',
        `Осталось ${plural(daysLeft, 'день', 'дня', 'дней')} — до ${formatDate(subscription.expiresAt)}.`,
        'Продлите заранее: оставшиеся дни не сгорят, новый срок прибавится к ним.',
      ].join('\n'),
    );

    // Помечаем в любом случае: если человек заблокировал бота, долбиться
    // в него каждый час бессмысленно.
    await markReminded(subscription.id, threshold);
    sent++;
  }

  if (sent > 0) logger.info({ count: sent }, 'напоминания о конце подписки отправлены');
  return sent;
}

/** Ближайший непройденный порог для этой подписки. */
function bucketFor(subscription: Subscription): number | undefined {
  const daysLeft = Math.ceil((subscription.expiresAt.getTime() - Date.now()) / 86_400_000);
  const threshold = THRESHOLDS.find((value) => daysLeft <= value);

  if (threshold === undefined) return undefined;
  // Этот порог или более близкий уже отработан.
  if (subscription.lastReminderDays !== null && subscription.lastReminderDays <= threshold) {
    return undefined;
  }

  return threshold;
}

async function notify(api: Api, userId: number, text: string): Promise<void> {
  try {
    await api.sendMessage(userId, text, {
      parse_mode: 'HTML',
      reply_markup: renewKeyboard(),
    });
  } catch (err) {
    // Заблокировал бота или удалил аккаунт — это нормальный исход, не ошибка.
    const description = err instanceof GrammyError ? err.description : String(err);
    logger.debug({ user: userId, description }, 'не доставили уведомление о подписке');
  }

  await new Promise((resolve) => setTimeout(resolve, SEND_GAP_MS));
}
