import { createHash } from 'node:crypto';
import type { Api } from 'grammy';
import { config } from './config.js';
import { logger } from './logger.js';
import { key, redis } from './redis.js';

/** Сколько молчать про ту же самую ошибку. */
const COOLDOWN_SEC = 900;

let api: Api | undefined;

/** Даём алертам доступ к Telegram. Вызывается один раз при старте. */
export function useApiForAlerts(value: Api): void {
  api = value;
}

/**
 * Сообщает администраторам о проблеме, которую никто не увидит в логах:
 * логи на хостинге смотрят раз в месяц, а бот тем временем лежит.
 *
 * Одинаковые ошибки схлопываются по ключу: упавший в цикле обработчик
 * не должен превратиться в тысячу сообщений и бан за флуд.
 */
export async function alertAdmins(text: string, dedupeKey?: string): Promise<void> {
  if (!api || config.ADMIN_IDS.length === 0) return;

  const fingerprint = createHash('sha1')
    .update(dedupeKey ?? text)
    .digest('hex')
    .slice(0, 16);

  try {
    // NX: первый прошёл, остальные молчат, пока ключ живёт.
    const fresh = await redis.set(key.alert(fingerprint), '1', 'EX', COOLDOWN_SEC, 'NX');
    if (fresh === null) return;
  } catch {
    // Redis лёг — тогда тем более надо сообщить, шлём без дедупликации.
  }

  for (const adminId of config.ADMIN_IDS) {
    await api
      .sendMessage(adminId, text, { parse_mode: 'HTML' })
      .catch((err) => logger.debug({ adminId, err }, 'алерт не доставлен'));
  }
}
