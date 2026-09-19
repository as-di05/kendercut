import { Redis } from 'ioredis';
import { config } from './config.js';
import { logger } from './logger.js';
import { onShutdown } from './shutdown.js';

export const redis = new Redis(config.REDIS_URL, {
  maxRetriesPerRequest: 3,
  // Иначе ioredis копит команды в буфере, пока Redis лежит, и отдаёт их пачкой.
  enableOfflineQueue: false,
  lazyConnect: true,
});

redis.on('error', (err: Error) => logger.error({ err: err.message }, 'ошибка redis'));

onShutdown('redis', async () => {
  await redis.quit();
});

/**
 * Подключается и проверяет связь. Вызывать обязательно до первого обращения
 * к redis: клиент ленивый, а очередь офлайн-команд выключена, поэтому любой
 * запрос до connect() падает с «Stream isn't writeable».
 */
export async function connectRedis(): Promise<void> {
  await redis.connect();
  const pong = await redis.ping();
  logger.info({ pong }, 'redis подключён');
}

/** Ключи с префиксом, чтобы не конфликтовать с чужими данными в той же базе Redis. */
export const key = {
  session: (id: string) => `ff:session:${id}`,
  rateLimit: (userId: number) => `ff:rl:${userId}`,
  sponsorCheck: (userId: number) => `ff:sponsor:${userId}`,
  /** Схлопывание одинаковых алертов админам. */
  alert: (fingerprint: string) => `ff:alert:${fingerprint}`,
  /** Поданная заявка в приватный канал: до одобрения getChatMember говорит «left». */
  sponsorJoin: (userId: number, chatId: number) => `ff:join:${userId}:${chatId}`,
};
