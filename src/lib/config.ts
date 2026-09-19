import 'dotenv/config';
import { z } from 'zod';

/** "123,456" -> [123, 456] */
const idList = z
  .string()
  .default('')
  .transform((raw) =>
    raw
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map(Number),
  )
  .pipe(z.array(z.number().int()));

/** Флаг из .env. z.coerce.boolean() не годится: строку "false" он тоже считает истиной. */
const boolFlag = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) =>
      raw === undefined || raw.trim() === ''
        ? fallback
        : ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase()),
    );

/** Обязательная строка с человекочитаемой подсказкой и для пустого, и для отсутствующего значения. */
const required = (hint: string) => z.string({ error: hint }).min(1, hint);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  BOT_TOKEN: required('обязателен, возьмите у @BotFather'),
  ADMIN_IDS: idList,

  // Канал-хранилище. Появится на этапе 3, поэтому пока не обязателен.
  STORAGE_CHANNEL_ID: z.coerce.number().int().optional(),

  DATABASE_URL: z
    .url()
    .default('postgres://filmfinder:filmfinder@localhost:5433/filmfinder'),
  REDIS_URL: z.url().default('redis://localhost:6379'),

  TMDB_API_KEY: z.string().optional(),

  /**
   * Публичный адрес сервиса. Задан — бот работает на вебхуке, пуст — на polling.
   * Вебхук нужен там, где хостинг требует занятый порт (web service),
   * и просто дешевле: Telegram сам стучится, а не бот опрашивает его.
   */
  WEBHOOK_URL: z.url().optional(),

  /**
   * Порт HTTP-сервера. На Render и подобных подставляется платформой.
   * Без вебхука сервер поднимается только ради healthcheck, и то если порт задан.
   */
  PORT: z.coerce.number().int().min(1).max(65535).optional(),

  /**
   * Через сколько минут удалять выданный пользователю фильм.
   * Потолок — 47 часов: Bot API не удаляет сообщения старше 48 часов,
   * и всё, что не успело исчезнуть до этой границы, останется навсегда.
   */
  AUTO_DELETE_MINUTES: z.coerce.number().int().positive().max(2820).default(2820),

  /**
   * Предлагать ли 30-дневный тариф ещё и как автопродляемую подписку Telegram.
   * 30 суток — единственный период, который разрешает Bot API; остальные тарифы
   * в любом случае продаются разовым счётом.
   */
  STARS_AUTO_RENEW: boolFlag(true),

  /**
   * Сколько каналов спонсоров показывать в гейте. Больше трёх-пяти люди
   * просто не проходят — уходят.
   */
  SPONSOR_MAX_CHANNELS: z.coerce.number().int().min(1).max(5).default(3),

  /**
   * На сколько секунд запоминать, что человек прошёл гейт.
   * 0 — проверять подписку при каждом запросе фильма: отписавшийся сразу
   * теряет доступ. Больше нуля — меньше запросов к Telegram, но столько же
   * секунд после отписки фильмы ещё выдаются.
   */
  SPONSOR_CACHE_SEC: z.coerce.number().int().min(0).max(3600).default(0),

  /**
   * Сколько дней получают оба — и пригласивший, и приглашённый.
   * 0 — рефералка выключена.
   */
  REFERRAL_BONUS_DAYS: z.coerce.number().int().min(0).max(365).default(3),

  /**
   * Сколько приглашений в сутки оплачивается одному человеку.
   * Сверх лимита приглашение фиксируется, но дней за него не начисляется.
   */
  REFERRAL_DAILY_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),

  /**
   * Сколько фильмов в сутки можно посмотреть бесплатно, пройдя гейт.
   * 0 — без ограничения. На подписчиков не распространяется.
   */
  FREE_VIEWS_PER_DAY: z.coerce.number().int().min(0).max(100).default(3),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
  // Логгер ещё не поднят — конфиг нужен ему самому, поэтому пишем напрямую.
  // eslint-disable-next-line no-console
  console.error(`Некорректный .env:\n${issues}`);
  process.exit(1);
}

export const config = Object.freeze(parsed.data);
export type Config = typeof config;

export const isProduction = config.NODE_ENV === 'production';
export const isAdmin = (userId: number | undefined): boolean =>
  userId !== undefined && config.ADMIN_IDS.includes(userId);
