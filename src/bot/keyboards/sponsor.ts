import { InlineKeyboard } from 'grammy';
import type { SponsorChannel } from '../../db/repositories/sponsors.js';
import { escapeHtml } from '../../lib/format.js';
import { nav } from './main.js';

export const gate = {
  check: (filmId: number) => `g:c:${filmId}`,
};

/** Ссылка, по которой человек подпишется: публичный канал — по юзернейму, приватный — по инвайту. */
export const joinLink = (channel: SponsorChannel): string | undefined =>
  channel.username ? `https://t.me/${channel.username}` : (channel.inviteLink ?? undefined);

/**
 * Экран гейта. Здесь же кнопка подписки — для части людей она и есть
 * выход из ситуации «опять подписываться», и это главный драйвер продаж.
 */
export function gateScreen(
  channels: SponsorChannel[],
  filmId: number,
): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const channel of channels) {
    const url = joinLink(channel);
    if (url) kb.url(`📢 ${channel.title}`, url).row();
  }
  kb.text('✅ Проверить', gate.check(filmId)).row();
  kb.text('⭐ Надоело подписываться — оформить подписку', nav.subscription);

  return {
    text: [
      '🔓 <b>Фильм почти ваш</b>',
      '',
      'Подпишитесь на каналы наших партнёров и нажмите «Проверить».',
      '',
      channels.map((c) => `• ${escapeHtml(c.title)}`).join('\n'),
    ].join('\n'),
    keyboard: kb,
  };
}
