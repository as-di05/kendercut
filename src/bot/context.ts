import type { Context, SessionFlavor } from 'grammy';
import type { User } from '../db/repositories/users.js';

/** Что бот ждёт от следующего текстового сообщения. */
export type Awaiting =
  | 'search'
  | 'film_title'
  | 'film_manual'
  | 'film_name'
  | 'film_desc'
  | 'film_year'
  | 'film_poster'
  | 'plan_new'
  | 'plan_title'
  | 'plan_price'
  | 'plan_days'
  | 'sponsor_title'
  | 'sponsor_link'
  | 'sponsor_starts'
  | 'sponsor_ends'
  | 'sponsor_target'
  | 'broadcast_text'
  | 'user_lookup';

export type SessionData = {
  awaiting?: Awaiting;
  /** Фильм, который сейчас оформляют в админском мастере. */
  draftFilmId?: number;
  /** Тариф, который правят в админке. */
  editPlanId?: number;
  /** Канал спонсора, который правят в админке. */
  editChannelId?: number;
  /** Сегмент готовящейся рассылки. */
  broadcastSegment?: 'all' | 'subscribers' | 'no_subscription';
  /** callback_data списка, из которого открыли карточку — для кнопки «Назад». */
  back?: string;
  /** Последний поисковый запрос, чтобы вернуться к его результатам. */
  lastQuery?: string;
};

export function initialSession(): SessionData {
  return {};
}

type Extra = {
  /** Строка из БД. Есть всегда после auth-middleware, кроме служебных апдейтов. */
  user: User;
  isAdmin: boolean;
};

export type BotContext = Context & SessionFlavor<SessionData> & Extra;
