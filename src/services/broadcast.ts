import type { Api } from 'grammy';
import { GrammyError } from 'grammy';
import {
  audiencePage,
  countAudience,
  getBroadcast,
  listRunning,
  segmentOf,
  updateBroadcast,
  type Broadcast,
} from '../db/repositories/broadcasts.js';
import { logger } from '../lib/logger.js';

/**
 * Пауза между сообщениями. Telegram пропускает около 30 в секунду, и это
 * общий лимит на бота: если выбрать его рассылкой, обычные ответы встанут
 * в очередь. Держимся заметно ниже потолка.
 */
const SEND_GAP_MS = 60;
const PAGE = 200;
/** Через сколько сообщений сверяться, не нажали ли «Остановить». */
const STATUS_CHECK_EVERY = 25;
/** Сколько отказов подряд с нуля отправленных считать поломкой самой рассылки. */
const MISFIRE_LIMIT = 10;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Запускает рассылку в фоне: админ не должен ждать её конца в чате. */
export function startBroadcast(api: Api, id: number): void {
  void run(api, id).catch((err) => logger.error({ err, broadcast: id }, 'рассылка упала'));
}

/**
 * Продолжает рассылки, оборванные перезапуском.
 * Курсор лежит в самой рассылке, поэтому никто не получит сообщение дважды.
 */
export async function resumeBroadcasts(api: Api): Promise<number> {
  const running = await listRunning();
  for (const broadcast of running) {
    logger.warn({ broadcast: broadcast.id, sent: broadcast.sent }, 'возобновляю рассылку');
    startBroadcast(api, broadcast.id);
  }
  return running.length;
}

export async function run(api: Api, id: number): Promise<Broadcast | undefined> {
  const started = await getBroadcast(id);
  if (!started) return undefined;

  const segment = segmentOf(started);
  const total = started.total > 0 ? started.total : await countAudience(segment);

  await updateBroadcast(id, { status: 'running', total });

  let sent = started.sent;
  let failed = started.failed;
  let cursor = started.lastUserId;
  let misfires = 0;

  for (;;) {
    const page = await audiencePage(segment, cursor, PAGE);
    if (page.length === 0) break;

    for (const [index, { tgId }] of page.entries()) {
      // Проверяем «Остановить» пачками: запрос в базу на каждого получателя
      // удваивал бы нагрузку ради кнопки, которую жмут раз в жизни.
      // Двадцать пять сообщений — это полторы секунды, реакция незаметна.
      if (index % STATUS_CHECK_EVERY === 0) {
        const current = await getBroadcast(id);
        if (current?.status !== 'running') {
          await updateBroadcast(id, { sent, failed, lastUserId: cursor });
          logger.info({ broadcast: id, sent }, 'рассылка остановлена');
          return current;
        }
      }

      try {
        await api.sendMessage(tgId, started.text, { parse_mode: 'HTML' });
        sent++;
        misfires = 0;
      } catch (err) {
        // Заблокировал бота, удалил аккаунт — обычное дело на любой рассылке.
        const description = err instanceof GrammyError ? err.description : String(err);
        logger.debug({ user: tgId, description }, 'не доставлено');
        failed++;
        misfires++;

        // Никто не получил, а подряд не уходит уже десяток — дело не в
        // получателях, а в самом сообщении (чаще всего битая HTML-разметка).
        // Продолжать значит молча сжечь всю рассылку.
        if (sent === 0 && misfires >= MISFIRE_LIMIT) {
          logger.error({ broadcast: id, description }, 'рассылка остановлена: не уходит ни одно');
          return updateBroadcast(id, {
            status: 'cancelled',
            sent,
            failed,
            lastUserId: cursor,
            finishedAt: new Date(),
          });
        }
      }

      cursor = tgId;
      await sleep(SEND_GAP_MS);
    }

    // Пишем прогресс порциями, а не после каждого сообщения: курсор нужен
    // только для того, чтобы не начать сначала после перезапуска.
    await updateBroadcast(id, { sent, failed, lastUserId: cursor });
  }

  const finished = await updateBroadcast(id, {
    status: 'done',
    sent,
    failed,
    lastUserId: cursor,
    finishedAt: new Date(),
  });

  logger.info({ broadcast: id, sent, failed }, 'рассылка закончена');
  return finished;
}
