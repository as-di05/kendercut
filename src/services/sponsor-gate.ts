import type { Api } from 'grammy';
import {
  listActiveChannels,
  recordPasses,
  type SponsorChannel,
} from '../db/repositories/sponsors.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { key, redis } from '../lib/redis.js';

/** Заявка в приватный канал живёт неделю: столько ждём одобрения от партнёра. */
const JOIN_REQUEST_SEC = 7 * 24 * 3600;

export type GateState =
  /** Каналов нет — бесплатного пути не существует. */
  | { status: 'off' }
  | { status: 'passed'; channels: SponsorChannel[] }
  | { status: 'blocked'; channels: SponsorChannel[]; missing: SponsorChannel[] };

/**
 * Проверяет подписку на каналы спонсоров.
 * Перепроверяем при каждом запросе фильма, а не один раз навсегда:
 * половина людей отписывается сразу после получения файла.
 */
export async function checkGate(api: Api, userId: number): Promise<GateState> {
  const channels = await listActiveChannels(config.SPONSOR_MAX_CHANNELS);
  if (channels.length === 0) return { status: 'off' };

  // В кэше лежит только успех: отказ кэшировать нельзя — человек нажимает
  // «Проверить» сразу после подписки и должен пройти немедленно.
  // При SPONSOR_CACHE_SEC=0 кэша нет вовсе: отписавшийся теряет доступ сразу.
  if (config.SPONSOR_CACHE_SEC > 0 && (await redis.get(key.sponsorCheck(userId)))) {
    return { status: 'passed', channels };
  }

  const verdicts = await Promise.all(channels.map((channel) => isMember(api, channel, userId)));
  const missing = channels.filter((_, i) => !verdicts[i]);

  if (missing.length > 0) return { status: 'blocked', channels, missing };

  if (config.SPONSOR_CACHE_SEC > 0) {
    await redis.set(key.sponsorCheck(userId), '1', 'EX', config.SPONSOR_CACHE_SEC);
  }
  await recordPasses(
    userId,
    channels.map((c) => c.id),
  );

  return { status: 'passed', channels };
}

/** Сбросить кэш — после того как человек нажал «Проверить». */
export async function forgetGateResult(userId: number): Promise<void> {
  await redis.del(key.sponsorCheck(userId));
}

/** Запомнить поданную заявку на вступление в приватный канал. */
export async function rememberJoinRequest(userId: number, chatId: number): Promise<void> {
  await redis.set(key.sponsorJoin(userId, chatId), '1', 'EX', JOIN_REQUEST_SEC);
}

async function isMember(api: Api, channel: SponsorChannel, userId: number): Promise<boolean> {
  // Пока заявку не одобрили, getChatMember всё ещё отвечает «left».
  if (await redis.get(key.sponsorJoin(userId, channel.chatId))) return true;

  try {
    const member = await api.getChatMember(channel.chatId, userId);
    switch (member.status) {
      case 'creator':
      case 'administrator':
      case 'member':
        return true;
      case 'restricted':
        return member.is_member;
      default:
        return false;
    }
  } catch (err) {
    // Бот не админ в канале или канал исчез — проверить нечем. Держать людей
    // в заложниках из-за чужой ошибки нельзя: пропускаем и кричим в лог.
    logger.error(
      { err, channel: channel.chatId, title: channel.title },
      'не удалось проверить подписку — бот всё ещё админ в канале?',
    );
    return true;
  }
}
