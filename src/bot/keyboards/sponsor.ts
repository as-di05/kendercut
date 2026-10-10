import { InlineKeyboard } from 'grammy';
import type { SponsorChannel } from '../../db/repositories/sponsors.js';
import { escapeHtml } from '../../lib/format.js';
import { nav } from './main.js';

export const gate = {
  /** Проверка перед выдачей файла: карточку человек уже видел. */
  check: (filmId: number) => `g:c:${filmId}`,
  /** Проверка перед показом карточки: человек пришёл по коду и ещё ничего не знает. */
  reveal: (filmId: number) => `g:r:${filmId}`,
};

/** Ссылка, по которой человек подпишется: публичный канал — по юзернейму, приватный — по инвайту. */
export const joinLink = (channel: SponsorChannel): string | undefined =>
  channel.username ? `https://t.me/${channel.username}` : (channel.inviteLink ?? undefined);

/**
 * Экран гейта. Здесь же кнопка подписки — для части людей она и есть
 * выход из ситуации «опять подписываться», и это главный драйвер продаж.
 */
/** Что человек получит после проверки: саму карточку или уже файл. */
export type GateMode = 'reveal' | 'watch';

export function gateScreen(
  channels: SponsorChannel[],
  filmId: number,
  mode: GateMode = 'watch',
): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const channel of channels) {
    const url = joinLink(channel);
    if (url) kb.url(`📢 ${channel.title}`, url).row();
  }
  kb.text('✅ Проверить', mode === 'reveal' ? gate.reveal(filmId) : gate.check(filmId)).row();
  kb.text('⭐ Надоело подписываться — оформить подписку', nav.subscription);

  return {
    text: [
      // Название фильма здесь не показываем намеренно: узнать, что за фильм
      // скрывается за кодом, — это и есть то, ради чего человек подписывается.
      // Назовём заранее — подписываться станет незачем.
      mode === 'reveal' ? '🔒 <b>Фильм скрыт</b>' : '🔓 <b>Фильм почти ваш</b>',
      '',
      mode === 'reveal'
        ? 'Подпишитесь на каналы наших партнёров и нажмите «Проверить» — покажу, что за фильм.'
        : 'Подпишитесь на каналы наших партнёров и нажмите «Проверить».',
      '',
      channels.map((c) => `• ${escapeHtml(c.title)}`).join('\n'),
    ].join('\n'),
    keyboard: kb,
  };
}

/**
 * Текст всплывающего окна «ещё не вижу подписки».
 * Telegram обрезает ответ на 200 символах и отвергает длиннее, поэтому
 * список названий подрезаем сами — иначе человек не увидит ничего.
 */
export function missingText(channels: SponsorChannel[]): string {
  const names = channels.map((c) => c.title).join(', ');
  const head = 'Пока не вижу подписки: ';
  return head + (names.length > 180 ? `${names.slice(0, 179)}…` : names);
}
