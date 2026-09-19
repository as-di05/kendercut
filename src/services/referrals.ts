import type { Api } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { db } from '../db/index.js';
import {
  countCreditedSince,
  createReferral,
  hasReferral,
} from '../db/repositories/referrals.js';
import { grantSubscription } from '../db/repositories/subscriptions.js';
import type { User } from '../db/repositories/users.js';
import { config } from '../lib/config.js';
import { escapeHtml, plural } from '../lib/format.js';
import { logger } from '../lib/logger.js';
import { nav } from '../bot/keyboards/main.js';

export type ReferralOutcome =
  | { status: 'off' }
  | { status: 'no_referrer' }
  | { status: 'already' }
  /** Сверх дневного лимита: приглашение записали, дней не дали. */
  | { status: 'limited' }
  | { status: 'credited'; inviterId: number; days: number };

/**
 * Засчитывает приглашение, когда приглашённый получил свой первый фильм.
 *
 * Момент выбран намеренно: за переход по ссылке бонус давать нельзя — это
 * накручивается пустыми аккаунтами за минуту. А чтобы получить фильм, надо
 * пройти гейт спонсоров или заплатить, то есть сделать ровно то, ради чего
 * человека и приглашали.
 */
export async function creditReferral(api: Api, invited: User): Promise<ReferralOutcome> {
  const days = config.REFERRAL_BONUS_DAYS;
  if (days === 0) return { status: 'off' };

  const inviterId = invited.referrerId;
  if (inviterId === null || inviterId === invited.tgId) return { status: 'no_referrer' };

  // Дешёвая проверка до транзакции: обычно мы попадаем именно сюда — фильм
  // смотрят много раз, а приглашение засчитывается один.
  if (await hasReferral(invited.tgId)) return { status: 'already' };

  const since = new Date(Date.now() - 86_400_000);
  if ((await countCreditedSince(inviterId, since)) >= config.REFERRAL_DAILY_LIMIT) {
    // Фиксируем факт, но без дней: так видно накрутку и не теряется статистика.
    await createReferral({ inviterId, invitedId: invited.tgId, bonusDays: 0 });
    logger.warn({ inviter: inviterId }, 'превышен дневной лимит приглашений');
    return { status: 'limited' };
  }

  const credited = await db.transaction(async (tx) => {
    const referral = await createReferral(
      { inviterId, invitedId: invited.tgId, bonusDays: days },
      tx,
    );
    // Кто-то успел раньше — второй раз не платим.
    if (!referral) return false;

    await grantSubscription({ userId: inviterId, days, source: 'referral' }, tx);
    await grantSubscription({ userId: invited.tgId, days, source: 'referral' }, tx);
    return true;
  });

  if (!credited) return { status: 'already' };

  logger.info({ inviter: inviterId, invited: invited.tgId, days }, 'приглашение засчитано');
  await tellInviter(api, inviterId, invited, days);

  return { status: 'credited', inviterId, days };
}

async function tellInviter(
  api: Api,
  inviterId: number,
  invited: User,
  days: number,
): Promise<void> {
  // Имя приходит из профиля Telegram, то есть его пишет сам человек:
  // без экранирования угловая скобка в имени ломает разметку сообщения.
  const name = escapeHtml(invited.firstName ?? 'Ваш друг');
  try {
    await api.sendMessage(
      inviterId,
      [
        '🎁 <b>Друг пришёл по вашей ссылке</b>',
        '',
        `${name} посмотрел первый фильм — вам начислено ${plural(days, 'день', 'дня', 'дней')}.`,
      ].join('\n'),
      {
        parse_mode: 'HTML',
        reply_markup: new InlineKeyboard().text('👤 Профиль', nav.profile),
      },
    );
  } catch (err) {
    logger.debug({ user: inviterId, err }, 'не доставили сообщение о приглашении');
  }
}
