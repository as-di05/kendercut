import type { Api } from 'grammy';
import { countViewsSince } from '../db/repositories/delivery.js';
import type { SponsorChannel } from '../db/repositories/sponsors.js';
import { getActiveSubscription } from '../db/repositories/subscriptions.js';
import { config, isAdmin } from '../lib/config.js';
import { checkGate } from './sponsor-gate.js';

const DAY_MS = 86_400_000;

/** Почему доступ дан или не дан. */
export type AccessResult =
  | { allowed: true; reason: 'admin' | 'subscription' | 'sponsor'; expiresAt?: Date }
  /** Гейта нет — остаётся только подписка. */
  | { allowed: false; reason: 'no_subscription' }
  | { allowed: false; reason: 'sponsor_required'; channels: SponsorChannel[]; missing: SponsorChannel[] }
  | { allowed: false; reason: 'daily_limit'; limit: number };

/**
 * Единственное место, где решается, можно ли пользователю смотреть.
 * Все обработчики обязаны спрашивать здесь: если проверок станет две,
 * они рано или поздно разойдутся.
 *
 * Порядок: админ → подписка → гейт спонсоров → дневной лимит бесплатных.
 */
export async function checkAccess(api: Api, userId: number): Promise<AccessResult> {
  if (isAdmin(userId)) return { allowed: true, reason: 'admin' };

  const subscription = await getActiveSubscription(userId);
  if (subscription) {
    return { allowed: true, reason: 'subscription', expiresAt: subscription.expiresAt };
  }

  const gate = await checkGate(api, userId);

  // Пока каналов спонсоров нет, бесплатного пути не существует: иначе
  // достаточно выключить последний канал, чтобы раздать весь каталог даром.
  if (gate.status === 'off') return { allowed: false, reason: 'no_subscription' };

  if (gate.status === 'blocked') {
    return {
      allowed: false,
      reason: 'sponsor_required',
      channels: gate.channels,
      missing: gate.missing,
    };
  }

  const limit = config.FREE_VIEWS_PER_DAY;
  if (limit > 0) {
    const today = await countViewsSince(userId, new Date(Date.now() - DAY_MS));
    if (today >= limit) return { allowed: false, reason: 'daily_limit', limit };
  }

  return { allowed: true, reason: 'sponsor' };
}
