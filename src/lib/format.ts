const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'Europe/Moscow',
});

export const formatDate = (date: Date): string => dateFormatter.format(date);

/** «3 дня», «21 день», «14 дней» — с правильным окончанием. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return `${n} ${many}`;
  if (mod10 === 1) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4) return `${n} ${few}`;
  return `${n} ${many}`;
}

export const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Москва живёт на UTC+3 круглый год, поэтому смещение константное. */
const MSK_OFFSET_MS = 3 * 3_600_000;

/**
 * «01.10.2026» → полночь этой даты по Москве.
 * Считаем именно по Москве, чтобы дата, которую ввёл админ, и дата,
 * которую он потом увидит в карточке, были одной и той же.
 */
export function parseMskDate(text: string): Date | undefined {
  const match = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(text.trim());
  if (!match) return undefined;

  const [, day, month, year] = match;
  const utcMidnight = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const date = new Date(utcMidnight - MSK_OFFSET_MS);

  // Date.UTC молча переносит 31.02 на 03.03 — такие даты отбрасываем.
  const back = new Date(utcMidnight);
  if (back.getUTCDate() !== Number(day) || back.getUTCMonth() !== Number(month) - 1) {
    return undefined;
  }

  return date;
}

/** Конец суток: срок размещения указывают «по такое-то число включительно». */
export const endOfMskDay = (date: Date): Date => new Date(date.getTime() + 86_400_000);
