import type { Api } from 'grammy';
import { resumeBroadcasts } from '../services/broadcast.js';
import { dropStaleDrafts } from '../db/repositories/broadcasts.js';
import { sweepDeletions } from './delete-delivered.js';
import { every } from './scheduler.js';
import { sweepExpired, sweepReminders } from './subscriptions.js';

const MINUTE = 60_000;

/** Ночью не пишем: напоминание в четыре утра раздражает сильнее, чем помогает. */
const QUIET_BEFORE_MSK = 10;
const QUIET_AFTER_MSK = 21;

export function startJobs(api: Api): void {
  // Рассылку мог оборвать перезапуск. Курсор лежит в самой рассылке,
  // поэтому продолжаем с того же места, а не с начала.
  void resumeBroadcasts(api);
  void dropStaleDrafts();

  // Выданные фильмы: срок короткий, проверяем часто.
  every('delete-delivered', MINUTE, () => sweepDeletions(api));

  // Истёкшие подписки: пять минут задержки никому не мешают.
  every('expire-subscriptions', 5 * MINUTE, () => sweepExpired(api));

  every('subscription-reminders', 60 * MINUTE, async () => {
    if (!isDaytimeMsk()) return;
    await sweepReminders(api);
  });
}

function isDaytimeMsk(date = new Date()): boolean {
  // Москва — UTC+3 круглый год, переводов часов нет.
  const hour = (date.getUTCHours() + 3) % 24;
  return hour >= QUIET_BEFORE_MSK && hour < QUIET_AFTER_MSK;
}
