import pino from 'pino';
import { config, isProduction } from './config.js';

/**
 * Всё, что не должно попасть в логи хостинга.
 * Токен бота лежит прямо в адресе каждого запроса к Telegram, а строки
 * подключения — в тексте ошибок драйверов; достаточно одной необработанной
 * ошибки, чтобы утекли и то и другое. Логи Render приватные, но токеном
 * бот угоняется целиком, поэтому подстраховаться дешевле, чем потом менять.
 */
const secrets = [
  config.BOT_TOKEN,
  config.TMDB_API_KEY,
  passwordOf(config.DATABASE_URL),
  passwordOf(config.REDIS_URL),
].filter((value): value is string => typeof value === 'string' && value.length > 6);

function passwordOf(url: string): string | undefined {
  try {
    return new URL(url).password || undefined;
  } catch {
    return undefined;
  }
}

const scrub = (text: string): string =>
  secrets.reduce((acc, secret) => acc.replaceAll(secret, '***'), text);

export const logger = pino({
  level: config.LOG_LEVEL,
  serializers: {
    // Ошибки — единственное место, куда секрет попадает не по нашей воле:
    // в тексте, в стеке, во вложенном cause.
    err: (err: unknown) => {
      const serialized = pino.stdSerializers.err(err as Error);
      const text = JSON.stringify(serialized);
      return secrets.some((secret) => text.includes(secret))
        ? (JSON.parse(scrub(text)) as unknown)
        : serialized;
    },
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      }),
});

export type Logger = typeof logger;
