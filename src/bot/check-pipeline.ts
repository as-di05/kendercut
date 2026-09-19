/* Офлайн-проверка цепочки middleware: сессия, регистрация, лимит частоты,
 * права админа, навигация по меню. Telegram не задействован — исходящие
 * вызовы перехватываются, входящие апдейты синтетические.
 * Запуск: npm run bot:check
 */
/* eslint-disable no-console */
import { and, eq, inArray, isNull, like } from 'drizzle-orm';
import type { Update } from 'grammy/types';
import { config } from '../lib/config.js';
import { alertAdmins, useApiForAlerts } from '../lib/alerts.js';
import { connectRedis, key, redis } from '../lib/redis.js';
import { db, sql } from '../db/index.js';
import {
  deliveredMessages,
  filmGenres,
  films,
  genres,
  payments,
  plans as plansTable,
  broadcasts,
  referrals,
  searchQueries,
  sponsorChannels,
  sponsorPasses,
  subscriptions,
  users,
  views,
} from '../db/schema.js';
import {
  getActiveSubscription,
  grantSubscription,
} from '../db/repositories/subscriptions.js';
import { listActivePlans, listPlans } from '../db/repositories/catalog.js';
import { getChannelByChatId } from '../db/repositories/sponsors.js';
import { referralStats } from '../db/repositories/referrals.js';
import { getBroadcast, listBroadcasts } from '../db/repositories/broadcasts.js';
import { run as runBroadcast } from '../services/broadcast.js';
import { dashboard } from '../db/repositories/analytics.js';
import { getUser } from '../db/repositories/users.js';
import { sweepDeletions } from '../jobs/delete-delivered.js';
import { sweepExpired, sweepReminders } from '../jobs/subscriptions.js';
import { createBot } from './index.js';

const ADMIN_ID = config.ADMIN_IDS[0] ?? 1;
const GUEST_ID = 999_000_001;

type Call = { method: string; payload: Record<string, unknown> };
const calls: Call[] = [];
/** Управляемая поломка copyMessage — для проверки отката на file_id. */
let breakCopyMessage = false;
/** Подписан ли тестовый пользователь на канал спонсора. */
let sponsorMember = false;

await connectRedis();

const bot = createBot();

// Перехватываем всё исходящее: наружу не уходит ни одного запроса.
bot.api.config.use(async (_prev, method, payload) => {
  calls.push({ method, payload: payload as Record<string, unknown> });
  if (breakCopyMessage && method === 'copyMessage') {
    throw new Error('Bad Request: message to copy not found');
  }
  if (method === 'getChatMember') {
    // Бота считаем админом канала, пользователя — по переключателю.
    const isBot = (payload as { user_id: number }).user_id === 1;
    return {
      ok: true,
      result: {
        status: isBot ? 'administrator' : sponsorMember ? 'member' : 'left',
        user: { id: (payload as { user_id: number }).user_id, is_bot: isBot, first_name: 'X' },
      },
    } as never;
  }
  if (method === 'createInvoiceLink') {
    return { ok: true, result: 'https://t.me/$test_invoice_link' } as never;
  }
  if (method === 'getMe') {
    return {
      ok: true,
      result: { id: 1, is_bot: true, first_name: 'test', username: 'test_bot' },
    } as never;
  }
  return { ok: true, result: { message_id: calls.length } } as never;
});

await bot.init();

/**
 * Проверки гейта исходят из того, что каналов спонсоров нет.
 * На рабочей базе они есть, поэтому выключаем их на время прогона —
 * и обязательно включаем обратно, в том числе при падении.
 */
const liveChannels = await db
  .select({ id: sponsorChannels.id })
  .from(sponsorChannels)
  .where(eq(sponsorChannels.isActive, true));

async function restoreChannels(): Promise<void> {
  if (liveChannels.length === 0) return;
  await db
    .update(sponsorChannels)
    .set({ isActive: true })
    .where(
      inArray(
        sponsorChannels.id,
        liveChannels.map((c) => c.id),
      ),
    );
}

if (liveChannels.length > 0) {
  await db
    .update(sponsorChannels)
    .set({ isActive: false })
    .where(
      inArray(
        sponsorChannels.id,
        liveChannels.map((c) => c.id),
      ),
    );
  console.log(`ℹ️  на время проверки выключено каналов спонсоров: ${liveChannels.length}`);
}

const bail = (err: unknown): void => {
  void restoreChannels().finally(() => {
    console.error(err);
    process.exit(1);
  });
};
process.on('uncaughtException', bail);
process.on('unhandledRejection', bail);

let updateId = 0;
const command = (userId: number, text: string): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Тест' },
      from: { id: userId, is_bot: false, first_name: 'Тест', username: 'tester' },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]!.length }],
    },
  }) as Update;

/** Обычное текстовое сообщение, без разметки команды. */
const text = (userId: number, body: string): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Тест' },
      from: { id: userId, is_bot: false, first_name: 'Тест', username: 'tester' },
      body,
      text: body,
    },
  }) as Update;

const press = (userId: number, data: string): Update =>
  ({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: { id: userId, is_bot: false, first_name: 'Тест' },
      chat_instance: '1',
      data,
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: userId, type: 'private', first_name: 'Тест' },
      },
    },
  }) as Update;

const preCheckout = (userId: number, payload: string, amount: number): Update =>
  ({
    update_id: ++updateId,
    pre_checkout_query: {
      id: String(updateId),
      from: { id: userId, is_bot: false, first_name: 'Тест' },
      currency: 'XTR',
      total_amount: amount,
      invoice_payload: payload,
    },
  }) as Update;

const paidMessage = (
  userId: number,
  payload: string,
  amount: number,
  chargeId: string,
  extra: Record<string, unknown> = {},
): Update =>
  ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: userId, type: 'private', first_name: 'Тест' },
      from: { id: userId, is_bot: false, first_name: 'Тест' },
      successful_payment: {
        currency: 'XTR',
        total_amount: amount,
        invoice_payload: payload,
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: `prov_${chargeId}`,
        ...extra,
      },
    },
  }) as unknown as Update;

const botPromoted = (chatId: number, title: string, status: string): Update =>
  ({
    update_id: ++updateId,
    my_chat_member: {
      chat: { id: chatId, type: 'channel', title, username: 'test_partner_channel' },
      from: { id: ADMIN_ID, is_bot: false, first_name: 'Админ' },
      date: Math.floor(Date.now() / 1000),
      old_chat_member: { status: 'left', user: { id: 1, is_bot: true, first_name: 'test' } },
      new_chat_member: { status, user: { id: 1, is_bot: true, first_name: 'test' } },
    },
  }) as unknown as Update;

const channelPost = (messageId: number, fileUniqueId: string, chatId?: number): Update =>
  ({
    update_id: ++updateId,
    channel_post: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId ?? config.STORAGE_CHANNEL_ID, type: 'channel', title: 'Хранилище' },
      caption: 'Тестовый фильм из канала',
      video: {
        file_id: `BAACtest${fileUniqueId}`,
        file_unique_id: fileUniqueId,
        width: 1920,
        height: 1080,
        duration: 7_200,
        file_size: 1_500_000_000,
      },
    },
  }) as unknown as Update;

const results: string[] = [];
const check = (ok: boolean, label: string) => {
  results.push(`${ok ? '✅' : '❌'} ${label}`);
};
const last = (method: string) => [...calls].reverse().find((c) => c.method === method);
const buttons = (payload?: Record<string, unknown>): string[] => {
  const markup = payload?.['reply_markup'] as { inline_keyboard?: { text: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => b.text);
};

// ── 1. /start от обычного пользователя ────────────────────────────
calls.length = 0;
await bot.handleUpdate(command(GUEST_ID, '/start'));
const greeting = last('sendMessage');
check(greeting !== undefined, 'на /start бот отвечает');
check(String(greeting?.payload['text']).includes('Кинотека'), 'в ответе приветствие');
check(buttons(greeting?.payload).length === 5, 'в меню 5 кнопок, админской нет');

const created = await db.query.users.findFirst({ where: eq(users.tgId, GUEST_ID) });
check(created !== undefined, 'пользователь записан в БД');

const sessionKeys = await redis.keys(key.session(String(GUEST_ID)));
check(sessionKeys.length === 1, 'сессия создана в Redis');

// ── 2. Админ видит лишнюю кнопку ──────────────────────────────────
calls.length = 0;
await bot.handleUpdate(command(ADMIN_ID, '/start'));
check(buttons(last('sendMessage')?.payload).length === 6, 'админу показана кнопка «Админка»');

// ── 3. Диплинк рефералки ──────────────────────────────────────────
const REF_ID = 999_000_002;
await bot.handleUpdate(command(REF_ID, `/start ref_${GUEST_ID}`));
const referred = await db.query.users.findFirst({ where: eq(users.tgId, REF_ID) });
check(referred?.referrerId === GUEST_ID, 'реферер сохранён из диплинка');

// Повторный /start по чужой ссылке не должен переписывать реферера.
await bot.handleUpdate(command(REF_ID, `/start ref_${ADMIN_ID}`));
const stillSame = await db.query.users.findFirst({ where: eq(users.tgId, REF_ID) });
check(stillSame?.referrerId === GUEST_ID, 'повторный диплинк реферера не переписал');

// Сам себя пригласить нельзя.
const SELF_ID = 999_000_003;
await bot.handleUpdate(command(SELF_ID, `/start ref_${SELF_ID}`));
const selfRef = await db.query.users.findFirst({ where: eq(users.tgId, SELF_ID) });
check(selfRef?.referrerId === null, 'самоприглашение отклонено');

// ── 4. Навигация ──────────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'nav:profile'));
const profile = last('editMessageText');
check(String(profile?.payload['text']).includes('Профиль'), 'кнопка «Профиль» открывает профиль');
check(String(profile?.payload['text']).includes('Подписка: нет'), 'в профиле статус подписки');

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'nav:unknown_button'));
check(last('answerCallbackQuery') !== undefined, 'устаревшая кнопка не молчит');

// ── 5. Ограничитель частоты ───────────────────────────────────────
const FLOOD_ID = 999_000_004;
await redis.del(key.rateLimit(FLOOD_ID));
calls.length = 0;
for (let i = 0; i < 30; i++) await bot.handleUpdate(command(FLOOD_ID, '/ping'));
const replies = calls.filter((c) => c.method === 'sendMessage').length;
check(replies === 21, `после 30 запросов ответов ${replies} (20 + одно предупреждение)`);
check(
  calls.some((c) => String(c.payload['text']).includes('Слишком много')),
  'предупреждение о флуде отправлено',
);

// Админ лимитом не ограничен.
await redis.del(key.rateLimit(ADMIN_ID));
calls.length = 0;
for (let i = 0; i < 30; i++) await bot.handleUpdate(command(ADMIN_ID, '/ping'));
check(
  calls.filter((c) => c.method === 'sendMessage').length === 30,
  'админ лимитом не ограничивается',
);

// ── 6. Бан ────────────────────────────────────────────────────────
const BANNED_ID = 999_000_005;
await bot.handleUpdate(command(BANNED_ID, '/start'));
await db.update(users).set({ isBanned: true }).where(eq(users.tgId, BANNED_ID));
calls.length = 0;
await bot.handleUpdate(command(BANNED_ID, '/start'));
check(calls.length === 0, 'забаненный не получает ответа');

// ── 7. Приём файла из канала-хранилища ────────────────────────────
const MSG_ID = 990_001;
const UNIQ = 'checkpipe1';
await db.delete(films).where(eq(films.fileUniqueId, UNIQ));

calls.length = 0;
await bot.handleUpdate(channelPost(MSG_ID, UNIQ));

const draft = await db.query.films.findFirst({ where: eq(films.fileUniqueId, UNIQ) });
check(draft !== undefined, 'файл из канала попал в каталог черновиком');
check(draft?.storageMessageId === MSG_ID, 'сохранён message_id для copyMessage');
check(draft?.isPublished === false, 'черновик не опубликован');
check(draft?.durationMin === 120, 'длительность посчитана из видео (7200 с → 120 мин)');
check(
  calls.some((c) => c.method === 'sendMessage' && String(c.payload['text']).includes('Новый файл')),
  'админ получил уведомление о новом файле',
);

// Повторная заливка того же файла не должна плодить дубли.
calls.length = 0;
await bot.handleUpdate(channelPost(MSG_ID + 1, UNIQ));
const copies = await db.select().from(films).where(eq(films.fileUniqueId, UNIQ));
check(copies.length === 1, 'повторная заливка не создала дубль');
check(
  calls.some((c) => String(c.payload['text']).includes('уже есть в каталоге')),
  'админ предупреждён о дубле',
);

// Пост из чужого канала игнорируется.
calls.length = 0;
await bot.handleUpdate(channelPost(1, 'foreign1', -1009999999999));
const foreign = await db.query.films.findFirst({ where: eq(films.fileUniqueId, 'foreign1') });
check(foreign === undefined && calls.length === 0, 'пост из чужого канала проигнорирован');

// ── 8. Мастер оформления ──────────────────────────────────────────
const draftId = draft!.id;

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:fill:${draftId}`));
check(
  String(last('sendMessage')?.payload['text']).includes('название'),
  'мастер просит прислать название',
);

calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, 'Начало'));
const named = await db.query.films.findFirst({ where: eq(films.id, draftId) });
check(named?.titleRu === 'Начало', 'название сохранено из сообщения');
check(
  calls.some((c) => String(c.payload['text'] ?? c.payload['caption']).includes('Начало')),
  'после ввода показана карточка',
);

// ── 8b. Редактор полей ────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:ed:${draftId}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Редактирование'),
  'меню редактирования открывается',
);

await bot.handleUpdate(press(ADMIN_ID, `a:f:${draftId}:desc`));
await bot.handleUpdate(text(ADMIN_ID, 'Вор проникает в сны, чтобы украсть идею.'));
const described = await db.query.films.findFirst({ where: eq(films.id, draftId) });
check(described?.description?.startsWith('Вор проникает') === true, 'описание сохранено');

await bot.handleUpdate(press(ADMIN_ID, `a:f:${draftId}:year`));
await bot.handleUpdate(text(ADMIN_ID, '2010'));
const dated = await db.query.films.findFirst({ where: eq(films.id, draftId) });
check(dated?.year === 2010, 'год сохранён');

// Мусор вместо года не должен записываться.
await bot.handleUpdate(press(ADMIN_ID, `a:f:${draftId}:year`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, 'позавчера'));
const unchanged = await db.query.films.findFirst({ where: eq(films.id, draftId) });
check(unchanged?.year === 2010, 'некорректный год отклонён');
check(
  String(last('sendMessage')?.payload['text']).includes('Не похоже на год'),
  'про некорректный год сказано',
);

// Из незавершённого ввода можно выйти командой.
await bot.handleUpdate(command(ADMIN_ID, '/start'));
check(
  (await redis.get(key.session(String(ADMIN_ID))))?.includes('film_year') !== true,
  'команда сбрасывает незавершённый ввод',
);

// Жанры переключаются.
const [firstGenre] = await db.select({ id: genres.id }).from(genres).limit(1);
await bot.handleUpdate(press(ADMIN_ID, `a:g:${draftId}:${firstGenre!.id}`));
const withGenre = await db
  .select()
  .from(filmGenres)
  .where(eq(filmGenres.filmId, draftId));
check(withGenre.length === 1, 'жанр добавлен');

await bot.handleUpdate(press(ADMIN_ID, `a:g:${draftId}:${firstGenre!.id}`));
const withoutGenre = await db
  .select()
  .from(filmGenres)
  .where(eq(filmGenres.filmId, draftId));
check(withoutGenre.length === 0, 'повторное нажатие жанр убирает');

// ── 9. Публикация ─────────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:pub1:${draftId}`));
const published = await db.query.films.findFirst({ where: eq(films.id, draftId) });
check(published?.isPublished === true, 'фильм опубликован');

// Без названия публиковать нельзя.
const NO_NAME_UNIQ = 'checkpipe2';
await db.delete(films).where(eq(films.fileUniqueId, NO_NAME_UNIQ));
await bot.handleUpdate(channelPost(990_010, NO_NAME_UNIQ));
const nameless = await db.query.films.findFirst({ where: eq(films.fileUniqueId, NO_NAME_UNIQ) });
await db.update(films).set({ titleRu: 'Без названия' }).where(eq(films.id, nameless!.id));

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:pub1:${nameless!.id}`));
const stillDraft = await db.query.films.findFirst({ where: eq(films.id, nameless!.id) });
check(stillDraft?.isPublished === false, 'фильм без названия не публикуется');
check(
  String(last('answerCallbackQuery')?.payload['text']).includes('название'),
  'админу объяснено, почему не опубликовалось',
);

// ── 10. Каталог ───────────────────────────────────────────────────
// Наполняем каталог, чтобы проверить пагинацию: 10 фильмов при странице в 8.
const CATALOG_UNIQS = Array.from({ length: 10 }, (_, i) => `checkcat${i}`);
await db.delete(films).where(inArray(films.fileUniqueId, CATALOG_UNIQS));
await db.insert(films).values(
  CATALOG_UNIQS.map((uniq, i) => ({
    titleRu: `Тестовый фильм ${i + 1}`,
    year: 2000 + i,
    storageChatId: -1000000000001,
    storageMessageId: 800_000 + i,
    fileUniqueId: uniq,
    fileId: `cat-file-${i}`,
    isPublished: true,
  })),
);

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'nav:catalog'));
check(
  String(last('editMessageText')?.payload['text']).includes('Каталог'),
  'каталог открывается',
);

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'c:new:0'));
const listPayload = last('editMessageText')?.payload;
const listButtons = buttons(listPayload);
check(
  listButtons.filter((b) => b.startsWith('Тестовый фильм')).length === 8,
  'на странице 8 фильмов',
);
check(listButtons.includes('1/2'), 'показан счётчик страниц');
check(listButtons.includes('›') && !listButtons.includes('‹'), 'на первой странице только «вперёд»');

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'c:new:1'));
const page2 = buttons(last('editMessageText')?.payload);
check(page2.filter((b) => b.startsWith('Тестовый фильм')).length === 2, 'на второй странице остаток');
check(page2.includes('‹') && !page2.includes('›'), 'на последней странице только «назад»');

// Карточка фильма и возврат к той же странице.
const someFilm = await db.query.films.findFirst({ where: eq(films.fileUniqueId, 'checkcat3') });
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, `c:f:${someFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Тестовый фильм 4'),
  'карточка фильма открывается',
);
check(buttons(last('sendMessage')?.payload).includes('▶️ Смотреть'), 'на карточке кнопка «Смотреть»');

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'c:back'));
check(
  buttons(last('editMessageText')?.payload).includes('2/2'),
  'возврат ведёт на ту же страницу списка',
);

// Диплинк на фильм.
calls.length = 0;
await bot.handleUpdate(command(GUEST_ID, `/start film_${someFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Тестовый фильм 4'),
  'диплинк film_N открывает карточку',
);

// ── 11. Поиск ─────────────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(text(GUEST_ID, 'Тестовый фильм 4'));
check(
  String(last('sendMessage')?.payload['text']).includes('Тестовый фильм 4'),
  'поиск находит по точному названию',
);

calls.length = 0;
await bot.handleUpdate(text(GUEST_ID, 'тестовыи фильм'));
check(
  buttons(last('sendMessage')?.payload).some((b) => b.startsWith('Тестовый фильм')),
  'поиск прощает опечатку',
);

calls.length = 0;
await bot.handleUpdate(text(GUEST_ID, 'фильм которого нет в базе'));
check(
  String(last('sendMessage')?.payload['text']).includes('ничего не нашлось'),
  'пустой результат объяснён',
);
const logged = await db
  .select()
  .from(searchQueries)
  .where(eq(searchQueries.query, 'фильм которого нет в базе'));
check(logged.length === 1 && logged[0]!.resultsCount === 0, 'пустой запрос записан в аналитику');

calls.length = 0;
await bot.handleUpdate(text(GUEST_ID, 'я'));
check(
  String(last('sendMessage')?.payload['text']).includes('Слишком короткий'),
  'слишком короткий запрос отклонён',
);

// ── 12. Пейволл и выдача ──────────────────────────────────────────
const watchFilm = await db.query.films.findFirst({ where: eq(films.fileUniqueId, 'checkcat0') });

// Без подписки — пейволл, файл не уходит.
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, `c:w:${watchFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Нужна подписка'),
  'без подписки показан пейволл',
);
check(!calls.some((c) => c.method === 'copyMessage'), 'без подписки файл не отправлен');
check(
  buttons(last('sendMessage')?.payload).some((b) => b.includes('⭐')),
  'на пейволле есть тарифы',
);

// Выдаём подписку и повторяем.
await grantSubscription({ userId: GUEST_ID, days: 30, source: 'admin' });

calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, `c:w:${watchFilm!.id}`));
const copy = calls.find((c) => c.method === 'copyMessage');
check(copy !== undefined, 'с подпиской фильм отправлен через copyMessage');
check(copy?.payload['protect_content'] === true, 'выдача защищена от пересылки');
check(
  copy?.payload['from_chat_id'] === watchFilm!.storageChatId &&
    copy?.payload['message_id'] === watchFilm!.storageMessageId,
  'копируется нужное сообщение из канала-хранилища',
);

const view = await db.select().from(views).where(eq(views.userId, GUEST_ID));
check(view.length === 1, 'просмотр записан');

const queued = await db
  .select()
  .from(deliveredMessages)
  .where(eq(deliveredMessages.userId, GUEST_ID));
check(queued.length === 1, 'сообщение поставлено в очередь на удаление');
const hoursUntilDelete = (queued[0]!.deleteAt.getTime() - Date.now()) / 3_600_000;
check(
  hoursUntilDelete > 46 && hoursUntilDelete < 48,
  `срок удаления ${hoursUntilDelete.toFixed(0)} ч — внутри 48-часового предела Telegram`,
);
check(
  !String(copy?.payload['caption']).includes('удалится'),
  'в подписи к фильму нет упоминания автоудаления',
);

// Экран подписки показывает актуальный статус.
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'nav:subscription'));
check(
  String(last('editMessageText')?.payload['text']).includes('Активна до'),
  'экран подписки показывает срок',
);

// Продление прибавляется к остатку, а не начинается заново.
const before = await getActiveSubscription(GUEST_ID);
await grantSubscription({ userId: GUEST_ID, days: 10, source: 'admin' });
const after = await getActiveSubscription(GUEST_ID);
const addedDays = Math.round(
  (after!.expiresAt.getTime() - before!.expiresAt.getTime()) / 86_400_000,
);
check(addedDays === 10, 'продление прибавляется к текущему сроку');

const activeCount = await db
  .select()
  .from(subscriptions)
  .where(and(eq(subscriptions.userId, GUEST_ID), eq(subscriptions.isActive, true)));
check(activeCount.length === 1, 'активная подписка остаётся одна');

// Если пост в канале удалили, выдача откатывается на сохранённый file_id.
breakCopyMessage = true;
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, `c:w:${watchFilm!.id}`));
breakCopyMessage = false;
const fallback = calls.find((c) => c.method === 'sendVideo');
check(fallback !== undefined, 'при недоступном посте выдача откатывается на file_id');
check(fallback?.payload['protect_content'] === true, 'откат тоже защищён от пересылки');

// ── 12b. Сборщик удалений ─────────────────────────────────────────
await db
  .update(deliveredMessages)
  .set({ deleteAt: new Date(Date.now() - 60_000) })
  .where(eq(deliveredMessages.userId, GUEST_ID));

calls.length = 0;
const swept = await sweepDeletions(bot.api);
check(swept === 2, 'сборщик забрал просроченные сообщения');
check(
  calls.filter((c) => c.method === 'deleteMessage').length === 2,
  'по каждому вызван deleteMessage',
);

const remaining = await db
  .select()
  .from(deliveredMessages)
  .where(and(eq(deliveredMessages.userId, GUEST_ID), isNull(deliveredMessages.deletedAt)));
check(remaining.length === 0, 'обработанные помечены удалёнными');
check((await sweepDeletions(bot.api)) === 0, 'повторный проход ничего не делает');

// ── 12c. Оплата звёздами ──────────────────────────────────────────
const PAY_ID = 999_000_006;
await bot.handleUpdate(command(PAY_ID, '/start'));

const plans = await listActivePlans();
const plan = plans[0]!;
const CHARGE = 'test_charge_stage6';

calls.length = 0;
await bot.handleUpdate(press(PAY_ID, `s:buy:${plan.id}`));
const invoice = last('sendInvoice');
check(invoice !== undefined, 'кнопка тарифа выставляет счёт');
check(invoice?.payload['currency'] === 'XTR', 'счёт выставлен в звёздах (XTR)');
check(
  (invoice?.payload['prices'] as { amount: number }[] | undefined)?.[0]?.amount === plan.priceStars,
  'сумма счёта равна цене тарифа',
);
check(invoice?.payload['payload'] === `sub:${plan.id}`, 'в payload счёта записан тариф');

// Подтверждение перед списанием.
calls.length = 0;
await bot.handleUpdate(preCheckout(PAY_ID, `sub:${plan.id}`, plan.priceStars));
check(last('answerPreCheckoutQuery')?.payload['ok'] === true, 'pre_checkout по живому тарифу подтверждён');

calls.length = 0;
await bot.handleUpdate(preCheckout(PAY_ID, 'sub:999999', plan.priceStars));
const denied = last('answerPreCheckoutQuery');
check(denied?.payload['ok'] === false, 'pre_checkout по несуществующему тарифу отклонён');
check(String(denied?.payload['error_message'] ?? '').length > 0, 'отказ объяснён пользователю');

// Лимит частоты не должен срывать оплату.
await redis.del(key.rateLimit(PAY_ID));
for (let i = 0; i < 25; i++) await bot.handleUpdate(command(PAY_ID, '/ping'));
calls.length = 0;
await bot.handleUpdate(preCheckout(PAY_ID, `sub:${plan.id}`, plan.priceStars));
check(
  last('answerPreCheckoutQuery') !== undefined,
  'оплата проходит даже при сработавшем лимите частоты',
);
await redis.del(key.rateLimit(PAY_ID));

// Деньги пришли.
calls.length = 0;
await bot.handleUpdate(paidMessage(PAY_ID, `sub:${plan.id}`, plan.priceStars, CHARGE));
check(
  String(last('sendMessage')?.payload['text']).includes('Оплата прошла'),
  'после оплаты бот подтверждает',
);

const paidSub = await getActiveSubscription(PAY_ID);
check(paidSub !== undefined, 'оплата открыла подписку');
const paidDays = Math.round((paidSub!.expiresAt.getTime() - Date.now()) / 86_400_000);
check(paidDays === plan.days, `выдано ровно ${plan.days} дн. по тарифу`);

const paymentRows = await db.select().from(payments).where(eq(payments.userId, PAY_ID));
check(
  paymentRows.length === 1 && paymentRows[0]!.status === 'paid',
  'платёж записан со статусом paid',
);
check(paymentRows[0]!.subscriptionId === paidSub!.id, 'платёж связан с выданной подпиской');

// Тот же charge_id второй раз — Telegram повторяет апдейты.
calls.length = 0;
await bot.handleUpdate(paidMessage(PAY_ID, `sub:${plan.id}`, plan.priceStars, CHARGE));
const afterDuplicate = await getActiveSubscription(PAY_ID);
check(
  afterDuplicate!.expiresAt.getTime() === paidSub!.expiresAt.getTime(),
  'повторный платёж с тем же charge_id подписку не продлевает',
);
check(
  (await db.select().from(payments).where(eq(payments.userId, PAY_ID))).length === 1,
  'дубль не попал в таблицу платежей',
);
check(
  String(last('sendMessage')?.payload['text']).includes('уже учтена'),
  'по дублю бот отвечает, что оплата учтена',
);

// Оплата по тарифу, которого нет.
calls.length = 0;
await bot.handleUpdate(paidMessage(PAY_ID, 'sub:999999', plan.priceStars, 'test_charge_orphan'));
check(
  String(last('sendMessage')?.payload['text']).includes('не распознан'),
  'оплата по неизвестному тарифу не теряется молча',
);

// Автопродление — только там, где Telegram его разрешает (30 суток).
const monthly = plans.find((p) => p.days === 30);
if (monthly && config.STARS_AUTO_RENEW) {
  calls.length = 0;
  await bot.handleUpdate(press(PAY_ID, 'nav:subscription'));
  check(
    buttons(last('editMessageText')?.payload).some((b) => b.startsWith('🔄')),
    'для месячного тарифа предложено автопродление',
  );

  calls.length = 0;
  await bot.handleUpdate(press(PAY_ID, `s:auto:${monthly.id}`));
  const link = last('createInvoiceLink');
  check(link?.payload['subscription_period'] === 2_592_000, 'подписочная ссылка на 30 суток');
  check(link?.payload['currency'] === 'XTR', 'подписка тоже оплачивается звёздами');
}

// Возврат.
calls.length = 0;
await bot.handleUpdate(command(ADMIN_ID, `/refund ${CHARGE}`));
check(
  last('refundStarPayment')?.payload['telegram_payment_charge_id'] === CHARGE,
  'возврат отправлен в Telegram',
);
const refunded = await db.select().from(payments).where(eq(payments.userId, PAY_ID));
check(refunded[0]!.status === 'refunded', 'платёж помечен возвращённым');
check((await getActiveSubscription(PAY_ID)) === undefined, 'после возврата подписка снята');
check(
  calls.some((c) => c.method === 'sendMessage' && c.payload['chat_id'] === PAY_ID),
  'пользователю сообщили о возврате',
);

calls.length = 0;
await bot.handleUpdate(command(ADMIN_ID, `/refund ${CHARGE}`));
check(!calls.some((c) => c.method === 'refundStarPayment'), 'повторный возврат в Telegram не уходит');

// ── 12d. Спонсорский гейт ─────────────────────────────────────────
const GATE_ID = 999_000_007;
const PARTNER_CHAT = -1_009_000_001;
await bot.handleUpdate(command(GATE_ID, '/start'));
// Результат гейта кэшируется на 5 минут — от прошлого прогона он остаться не должен.
await redis.del(key.sponsorCheck(GATE_ID));

// Канал регистрируется сам, когда бота делают администратором.
calls.length = 0;
await bot.handleUpdate(botPromoted(PARTNER_CHAT, 'Канал партнёра', 'administrator'));
const registered = await getChannelByChatId(PARTNER_CHAT);
check(registered !== undefined, 'канал регистрируется при назначении бота админом');
check(registered?.isActive === false, 'новый канал выключен, пока админ его не включил');
check(
  calls.some((c) => String(c.payload['text']).includes('сделали админом')),
  'админу пришло уведомление о новом канале',
);

// Пока канал выключен, бесплатного пути нет — только подписка.
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `c:w:${watchFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Нужна подписка'),
  'без включённых каналов гейта нет — показан пейволл',
);

// Включаем канал через админку.
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:sp2:${registered!.id}`));
check((await getChannelByChatId(PARTNER_CHAT))?.isActive === true, 'админ включил канал в гейт');

// Теперь вместо пейволла — гейт.
sponsorMember = false;
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `c:w:${watchFilm!.id}`));
const gateScreenCall = last('sendMessage');
check(
  String(gateScreenCall?.payload['text']).includes('Подпишитесь на каналы'),
  'без подписки на канал показан гейт',
);
check(
  buttons(gateScreenCall?.payload).some((b) => b.includes('Проверить')),
  'в гейте есть кнопка «Проверить»',
);
check(
  buttons(gateScreenCall?.payload).some((b) => b.includes('подписку')),
  'в гейте предложена платная подписка',
);
check(!calls.some((c) => c.method === 'copyMessage'), 'непройденный гейт файл не отдаёт');

// «Проверить» при неподписанном пользователе.
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `g:c:${watchFilm!.id}`));
check(
  String(last('answerCallbackQuery')?.payload['text']).includes('не вижу подписки'),
  'кнопка «Проверить» честно говорит, что подписки нет',
);
check(!calls.some((c) => c.method === 'copyMessage'), 'по непройденной проверке файл не уходит');

// Подписался и проверил ещё раз.
sponsorMember = true;
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `g:c:${watchFilm!.id}`));
check(calls.some((c) => c.method === 'copyMessage'), 'после подписки фильм выдан без оплаты');

const passes = await db.select().from(sponsorPasses).where(eq(sponsorPasses.userId, GATE_ID));
check(passes.length === 1, 'прохождение гейта записано');
check(
  (await getChannelByChatId(PARTNER_CHAT))?.joinedCount === 1,
  'счётчик партнёра увеличился',
);

// Повторный проход тем же человеком счётчик не накручивает.
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `g:c:${watchFilm!.id}`));
check(
  (await getChannelByChatId(PARTNER_CHAT))?.joinedCount === 1,
  'повторный проход счётчик партнёра не накручивает',
);

// Дневной лимит бесплатных просмотров.
if (config.FREE_VIEWS_PER_DAY > 0) {
  const already = await db.select().from(views).where(eq(views.userId, GATE_ID));
  const missing = config.FREE_VIEWS_PER_DAY - already.length;
  if (missing > 0) {
    await db
      .insert(views)
      .values(Array.from({ length: missing }, () => ({ userId: GATE_ID, filmId: watchFilm!.id })));
  }

  calls.length = 0;
  await bot.handleUpdate(press(GATE_ID, `c:w:${watchFilm!.id}`));
  check(
    String(last('sendMessage')?.payload['text']).includes('На сегодня всё'),
    'дневной лимит бесплатных просмотров срабатывает',
  );
  check(!calls.some((c) => c.method === 'copyMessage'), 'сверх лимита файл не отдаётся');
}

// Подписчику гейт не показывают вовсе.
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, `c:w:${watchFilm!.id}`));
check(
  calls.some((c) => c.method === 'copyMessage'),
  'подписчик получает фильм мимо гейта и лимитов',
);

// Бота разжаловали — канал уходит из гейта сам.
calls.length = 0;
await bot.handleUpdate(botPromoted(PARTNER_CHAT, 'Канал партнёра', 'left'));
check(
  (await getChannelByChatId(PARTNER_CHAT))?.isActive === false,
  'канал выключается, когда бот теряет права админа',
);
check(
  calls.some((c) => String(c.payload['text']).includes('Канал выключен')),
  'админа предупредили о выключении канала',
);

// ── 12e. Админка тарифов ──────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, 'a:pl'));
check(
  String(last('editMessageText')?.payload['text']).includes('Тарифы'),
  'в админке есть раздел тарифов',
);

// Новый тариф: срок и цена одной строкой.
await bot.handleUpdate(press(ADMIN_ID, 'a:pl+'));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, '14 149'));
const createdPlan = (await listPlans()).find((p) => p.days === 14 && p.priceStars === 149);
check(createdPlan !== undefined, 'админ создаёт тариф одной строкой');
check(createdPlan?.isActive === false, 'новый тариф не продаётся, пока его не включили');
check(
  !(await listActivePlans()).some((p) => p.id === createdPlan!.id),
  'выключенный тариф не показывается пользователям',
);

// Цена меняется.
await bot.handleUpdate(press(ADMIN_ID, `a:plf:${createdPlan!.id}:price`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, '199'));
check(
  (await listPlans()).find((p) => p.id === createdPlan!.id)?.priceStars === 199,
  'админ меняет цену тарифа',
);

// Мусор вместо цены не сохраняется.
await bot.handleUpdate(press(ADMIN_ID, `a:plf:${createdPlan!.id}:price`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, 'дёшево'));
check(
  String(last('sendMessage')?.payload['text']).includes('целое число'),
  'нечисловая цена отклонена',
);
check(
  (await listPlans()).find((p) => p.id === createdPlan!.id)?.priceStars === 199,
  'после отказа цена осталась прежней',
);

// Включение и цена в счёте.
await bot.handleUpdate(press(ADMIN_ID, `a:pl2:${createdPlan!.id}`));
check(
  (await listActivePlans()).some((p) => p.id === createdPlan!.id),
  'включённый тариф появляется у пользователей',
);

calls.length = 0;
await bot.handleUpdate(press(PAY_ID, `s:buy:${createdPlan!.id}`));
check(
  (last('sendInvoice')?.payload['prices'] as { amount: number }[] | undefined)?.[0]?.amount === 199,
  'счёт выставляется по новой цене',
);

await bot.handleUpdate(press(ADMIN_ID, `a:pl3:${createdPlan!.id}`));
check(
  (await listPlans()).every((p) => p.id !== createdPlan!.id),
  'админ удаляет тариф',
);

// ── 12f. Срок размещения канала ───────────────────────────────────
await bot.handleUpdate(botPromoted(PARTNER_CHAT, 'Канал партнёра', 'administrator'));
const timed = await getChannelByChatId(PARTNER_CHAT);
await bot.handleUpdate(press(ADMIN_ID, `a:sp2:${timed!.id}`));

// Название и план по подписчикам.
await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:title`));
await bot.handleUpdate(text(ADMIN_ID, 'Канал про кино'));
await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:target`));
await bot.handleUpdate(text(ADMIN_ID, '500'));
const renamed = await getChannelByChatId(PARTNER_CHAT);
check(renamed?.title === 'Канал про кино', 'админ меняет название канала');
check(renamed?.targetJoins === 500, 'админ задаёт план по подписчикам');

// Размещение с завтрашнего дня — канал в гейт пока не идёт.
const tomorrow = new Date(Date.now() + 86_400_000);
const asDate = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;

await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:starts`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, asDate(tomorrow)));
check(
  (await getChannelByChatId(PARTNER_CHAT))?.startsAt !== null,
  'админ задаёт дату начала размещения',
);
check(
  String(last('sendMessage')?.payload['text']).includes('ждёт начала'),
  'карточка объясняет, что размещение ещё не началось',
);

await redis.del(key.sponsorCheck(GATE_ID));
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `c:w:${watchFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Нужна подписка'),
  'канал с будущей датой в гейте не участвует',
);

// Срок истёк — тоже мимо гейта.
await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:starts`));
await bot.handleUpdate(text(ADMIN_ID, '-'));
await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:ends`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, asDate(new Date(Date.now() - 2 * 86_400_000))));
check(
  String(last('sendMessage')?.payload['text']).includes('истёк'),
  'карточка показывает, что срок размещения вышел',
);

await redis.del(key.sponsorCheck(GATE_ID));
calls.length = 0;
await bot.handleUpdate(press(GATE_ID, `c:w:${watchFilm!.id}`));
check(
  String(last('sendMessage')?.payload['text']).includes('Нужна подписка'),
  'канал с истёкшим сроком в гейте не участвует',
);

// Неверная дата ничего не ломает.
await bot.handleUpdate(press(ADMIN_ID, `a:spf:${timed!.id}:ends`));
calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, '31.02.2027'));
check(
  String(last('sendMessage')?.payload['text']).includes('Не похоже на дату'),
  'несуществующая дата отклонена',
);

// ── 12g. Истечение подписок и напоминания ─────────────────────────
const EXP_ID = 999_000_008;
await bot.handleUpdate(command(EXP_ID, '/start'));

// Подписка кончается через два дня — это порог «3 дня».
await grantSubscription({ userId: EXP_ID, days: 2, source: 'admin' });
calls.length = 0;
check((await sweepReminders(bot.api)) === 1, 'напоминание за 3 дня отправлено');
check(
  String(last('sendMessage')?.payload['text']).includes('скоро закончится'),
  'в напоминании сказано, что подписка на исходе',
);
check(
  buttons(last('sendMessage')?.payload).some((b) => b.includes('Продлить')),
  'в напоминании есть кнопка продления',
);
check((await sweepReminders(bot.api)) === 0, 'тот же порог второй раз не срабатывает');

// Сдвигаем срок внутрь суток — это уже порог «1 день».
await db
  .update(subscriptions)
  .set({ expiresAt: new Date(Date.now() + 12 * 3_600_000) })
  .where(and(eq(subscriptions.userId, EXP_ID), eq(subscriptions.isActive, true)));
check((await sweepReminders(bot.api)) === 1, 'напоминание за 1 день отправлено');
check((await sweepReminders(bot.api)) === 0, 'и оно тоже одноразовое');

// Автопродляемым не пишем: о списании предупреждает сам Telegram.
const AUTO_ID = 999_000_009;
await bot.handleUpdate(command(AUTO_ID, '/start'));
await grantSubscription({ userId: AUTO_ID, days: 2, source: 'payment', autoRenew: true });
check((await sweepReminders(bot.api)) === 0, 'по автопродляемой подписке напоминаний нет');

// Срок вышел.
await db
  .update(subscriptions)
  .set({ expiresAt: new Date(Date.now() - 60_000) })
  .where(and(eq(subscriptions.userId, EXP_ID), eq(subscriptions.isActive, true)));

calls.length = 0;
check((await sweepExpired(bot.api)) === 1, 'истёкшая подписка закрыта');
check(
  String(last('sendMessage')?.payload['text']).includes('Подписка закончилась'),
  'человеку сообщили об окончании',
);
check((await getActiveSubscription(EXP_ID)) === undefined, 'доступ по ней больше не действует');
check((await sweepExpired(bot.api)) === 0, 'повторный проход ничего не закрывает');

// Досрочное продление не должно превращаться в «закончилась».
await grantSubscription({ userId: EXP_ID, days: 30, source: 'admin' });
check((await sweepExpired(bot.api)) === 0, 'продлённая подписка не закрывается');
check(
  (await getActiveSubscription(EXP_ID)) !== undefined,
  'после продления доступ снова есть',
);

// ── 12h. Рефералка ────────────────────────────────────────────────
const INVITER_ID = 999_000_010;
const INVITED_ID = 999_000_011;

await bot.handleUpdate(command(INVITER_ID, '/start'));

// Экран приглашения: ссылка и статистика.
calls.length = 0;
await bot.handleUpdate(press(INVITER_ID, 'nav:invite'));
const inviteScreen = last('editMessageText');
check(
  String(inviteScreen?.payload['text']).includes(`?start=ref_${INVITER_ID}`),
  'на экране приглашения личная ссылка пользователя',
);
check(
  buttons(inviteScreen?.payload).some((b) => b.includes('Поделиться')),
  'есть кнопка «Поделиться»',
);

// Друг пришёл по ссылке, но пока ничего не смотрел — бонуса нет.
await bot.handleUpdate(command(INVITED_ID, `/start ref_${INVITER_ID}`));
check(
  (await referralStats(INVITER_ID)).days === 0,
  'за один переход по ссылке бонус не начисляется',
);

// Смотрит первый фильм — вот теперь засчитываем обоим.
await grantSubscription({ userId: INVITED_ID, days: 1, source: 'admin' });
const inviterBefore = await getActiveSubscription(INVITER_ID);
calls.length = 0;
await bot.handleUpdate(press(INVITED_ID, `c:w:${watchFilm!.id}`));

const afterInvite = await referralStats(INVITER_ID);
check(afterInvite.invited === 1, 'приглашение записано после первого просмотра');
check(
  afterInvite.days === config.REFERRAL_BONUS_DAYS,
  `пригласившему начислено ${config.REFERRAL_BONUS_DAYS} дн.`,
);
check(inviterBefore === undefined, 'до приглашения подписки у пригласившего не было');
check(
  (await getActiveSubscription(INVITER_ID)) !== undefined,
  'пригласившему открылась подписка',
);
check(
  calls.some((c) => c.method === 'sendMessage' && c.payload['chat_id'] === INVITER_ID),
  'пригласившему пришло уведомление',
);

const invitedSub = await getActiveSubscription(INVITED_ID);
const invitedDays = Math.round((invitedSub!.expiresAt.getTime() - Date.now()) / 86_400_000);
check(invitedDays === 1 + config.REFERRAL_BONUS_DAYS, 'приглашённому бонус прибавлен к его дням');

// Второй фильм ничего не добавляет.
calls.length = 0;
await bot.handleUpdate(press(INVITED_ID, `c:w:${watchFilm!.id}`));
check(
  (await referralStats(INVITER_ID)).days === config.REFERRAL_BONUS_DAYS,
  'повторный просмотр второй раз не оплачивается',
);

// Дневной лимит: добиваем счётчик до предела и зовём ещё одного.
const FARM_BASE = 999_001_000;
const farmIds = Array.from(
  { length: config.REFERRAL_DAILY_LIMIT - 1 },
  (_, i) => FARM_BASE + i,
);
if (farmIds.length > 0) {
  await db.insert(users).values(farmIds.map((tgId) => ({ tgId, firstName: 'Ферма' })));
  await db.insert(referrals).values(
    farmIds.map((invitedId) => ({
      inviterId: INVITER_ID,
      invitedId,
      bonusDays: config.REFERRAL_BONUS_DAYS,
    })),
  );
}

const OVER_ID = 999_000_012;
await bot.handleUpdate(command(OVER_ID, `/start ref_${INVITER_ID}`));
await grantSubscription({ userId: OVER_ID, days: 1, source: 'admin' });
const daysBeforeLimit = (await referralStats(INVITER_ID)).days;
await bot.handleUpdate(press(OVER_ID, `c:w:${watchFilm!.id}`));
const afterLimit = await referralStats(INVITER_ID);
check(afterLimit.days === daysBeforeLimit, 'сверх дневного лимита дни не начисляются');
check(afterLimit.invited === config.REFERRAL_DAILY_LIMIT + 1, 'но само приглашение записано');

// ── 12i. Статистика ───────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, 'a:st'));
const statsText = String(last('editMessageText')?.payload['text']);
check(statsText.includes('Статистика'), 'админка показывает сводку');
check(statsText.includes('Пользователей'), 'в сводке есть счётчик пользователей');
check(statsText.includes('⭐'), 'в сводке есть заработок в звёздах');

const numbers = await dashboard();
check(numbers.users > 0, 'запрос сводки считает пользователей');
check(
  statsText.includes(String(numbers.activeSubs)),
  'число активных подписок попало в текст',
);

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, 'a:st:top'));
check(
  String(last('editMessageText')?.payload['text']).includes('Топ за 30 дней'),
  'открывается топ фильмов',
);

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, 'a:st:miss'));
check(
  String(last('editMessageText')?.payload['text']).includes('Пустые запросы'),
  'открывается отчёт «искали, но не нашли»',
);

// ── 12j. Рассылка ─────────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, 'a:bc+:all'));
check(
  String(last('sendMessage')?.payload['text']).includes('Получателей'),
  'перед рассылкой показано число получателей',
);

calls.length = 0;
await bot.handleUpdate(text(ADMIN_ID, 'Привет, это <b>тест</b>'));
const mailing = (await listBroadcasts(1))[0];
check(mailing?.status === 'draft', 'рассылка создана черновиком, а не улетела сразу');
check(mailing?.text === 'Привет, это <b>тест</b>', 'текст сохранён как есть, вместе с разметкой');
check(
  buttons(last('sendMessage')?.payload).some((b) => b.includes('Отправить')),
  'в карточке черновика есть кнопка отправки',
);

// Прогон рассылки напрямую: в боевом коде она уходит в фон.
calls.length = 0;
const finished = await runBroadcast(bot.api, mailing!.id);
check(finished?.status === 'done', 'рассылка доходит до конца');
check(finished!.sent > 0, `разослано сообщений: ${finished!.sent}`);
check(
  calls.filter((c) => c.method === 'sendMessage').length === finished!.sent,
  'сообщений отправлено ровно столько, сколько записано',
);
check(finished?.lastUserId !== null, 'курсор сохранён — есть откуда продолжить');

// Забаненные в рассылку не попадают.
const bannedGotIt = calls.some(
  (c) => c.method === 'sendMessage' && c.payload['chat_id'] === BANNED_ID,
);
check(!bannedGotIt, 'забаненный рассылку не получает');

// Повторный прогон ничего не дублирует: курсор дошёл до конца.
calls.length = 0;
await runBroadcast(bot.api, mailing!.id);
check(
  calls.filter((c) => c.method === 'sendMessage').length === 0,
  'повторный прогон не рассылает второй раз',
);

// Остановка на ходу.
const stopDraft = (await listBroadcasts(5)).find((b) => b.id === mailing!.id);
check(stopDraft !== undefined, 'рассылка осталась в истории');

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:bc4:${mailing!.id}`));
check((await getBroadcast(mailing!.id)) === undefined, 'админ удаляет рассылку');

// ── 12k. Карточка пользователя ────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(command(ADMIN_ID, `/user ${GUEST_ID}`));
const card = last('sendMessage');
check(String(card?.payload['text']).includes(String(GUEST_ID)), 'карточка пользователя открывается');
check(
  String(card?.payload['text']).includes('Подписка'),
  'в карточке видно состояние подписки',
);

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:ub:${GUEST_ID}`));
check((await getUser(GUEST_ID))?.isBanned === true, 'админ блокирует пользователя из карточки');

calls.length = 0;
await bot.handleUpdate(command(GUEST_ID, '/start'));
check(calls.length === 0, 'заблокированному бот не отвечает');

await bot.handleUpdate(press(ADMIN_ID, `a:ub:${GUEST_ID}`));
check((await getUser(GUEST_ID))?.isBanned === false, 'и разблокирует обратно');

calls.length = 0;
await bot.handleUpdate(press(ADMIN_ID, `a:ug:${GUEST_ID}`));
check(
  (await getActiveSubscription(GUEST_ID)) !== undefined,
  'админ выдаёт подписку кнопкой из карточки',
);

// ── 12l. Алерты администраторам ───────────────────────────────────
useApiForAlerts(bot.api);
const alertText = `проверочная ошибка ${Date.now()}`;

calls.length = 0;
await alertAdmins(alertText);
check(
  calls.some((c) => c.method === 'sendMessage' && c.payload['chat_id'] === ADMIN_ID),
  'о поломке бот пишет администратору',
);

calls.length = 0;
await alertAdmins(alertText);
check(
  !calls.some((c) => c.method === 'sendMessage'),
  'повторная та же ошибка админа не будит',
);

// ── 13. Права ─────────────────────────────────────────────────────
calls.length = 0;
await bot.handleUpdate(press(GUEST_ID, 'a:drafts'));
check(
  !calls.some((c) => String(c.payload['text']).includes('Неоформленные')),
  'обычный пользователь в админку не попадает',
);

// Лимитер к этому моменту уже на взводе — иначе его предупреждение
// прилетит вместо ответа админки и проверка станет бессмысленной.
await redis.del(key.rateLimit(GUEST_ID));

for (const data of ['a:st', 'a:bc', 'a:pl', 'a:sp', `a:ug:${ADMIN_ID}`]) {
  calls.length = 0;
  await bot.handleUpdate(press(GUEST_ID, data));
  check(
    !calls.some((c) => c.method === 'editMessageText' || c.method === 'sendMessage'),
    `обычный пользователь не открывает ${data}`,
  );
}

calls.length = 0;
await bot.handleUpdate(command(GUEST_ID, `/user ${ADMIN_ID}`));
check(!calls.some((c) => c.method === 'sendMessage'), 'команда /user доступна только админу');

// ── Итоги ─────────────────────────────────────────────────────────
console.log('\n' + results.join('\n'));
const failed = results.filter((r) => r.startsWith('❌')).length;
console.log(`\n${results.length - failed} из ${results.length} проверок пройдено`);

// Уборка.
await db.delete(films).where(inArray(films.fileUniqueId, [UNIQ, NO_NAME_UNIQ, 'foreign1', ...CATALOG_UNIQS]));
// user_id у запросов обнуляется при удалении юзера, поэтому чистим и по тексту:
// иначе мусор от упавшего прогона ломает следующий.
await db.delete(searchQueries).where(inArray(searchQueries.userId, [GUEST_ID]));
await db.delete(searchQueries).where(eq(searchQueries.query, 'фильм которого нет в базе'));
const testIds = [
  GUEST_ID,
  REF_ID,
  SELF_ID,
  FLOOD_ID,
  BANNED_ID,
  PAY_ID,
  GATE_ID,
  EXP_ID,
  AUTO_ID,
  INVITER_ID,
  INVITED_ID,
  OVER_ID,
  ...farmIds,
];
await db.delete(broadcasts).where(eq(broadcasts.text, 'Привет, это <b>тест</b>'));
await db.delete(sponsorChannels).where(eq(sponsorChannels.chatId, PARTNER_CHAT));
await db.delete(plansTable).where(like(plansTable.code, 'd14%'));
await restoreChannels();
await db.delete(users).where(inArray(users.tgId, testIds));
await Promise.all(
  testIds.map((id) =>
    redis.del(key.session(String(id)), key.rateLimit(id), key.sponsorCheck(id)),
  ),
);
await redis.quit();
await sql.end();
process.exit(failed === 0 ? 0 : 1);
