import { InlineKeyboard } from 'grammy';

/**
 * callback_data ограничена 64 байтами, поэтому префиксы короткие.
 * Всё в одном месте, чтобы обработчики и кнопки не разъезжались.
 */
export const admin = {
  panel: 'a:panel',
  drafts: 'a:drafts',
  published: 'a:pub',

  card: (id: number) => `a:card:${id}`,
  fill: (id: number) => `a:fill:${id}`,
  manual: (id: number) => `a:man:${id}`,

  edit: (id: number) => `a:ed:${id}`,
  field: (id: number, field: EditField) => `a:f:${id}:${field}`,
  genresScreen: (id: number) => `a:gs:${id}`,
  toggleGenre: (id: number, genreId: number) => `a:g:${id}:${genreId}`,
  pick: (filmId: number, tmdbId: number) => `a:pick:${filmId}:${tmdbId}`,
  publish: (id: number) => `a:pub1:${id}`,
  unpublish: (id: number) => `a:pub0:${id}`,
  confirmDelete: (id: number) => `a:del?:${id}`,
  doDelete: (id: number) => `a:del!:${id}`,

  sponsors: 'a:sp',
  sponsor: (id: number) => `a:sp1:${id}`,
  sponsorToggle: (id: number) => `a:sp2:${id}`,
  sponsorDelete: (id: number) => `a:sp3:${id}`,
  sponsorField: (id: number, field: ChannelField) => `a:spf:${id}:${field}`,

  plans: 'a:pl',
  plan: (id: number) => `a:pl1:${id}`,
  planToggle: (id: number) => `a:pl2:${id}`,
  planDelete: (id: number) => `a:pl3:${id}`,
  planField: (id: number, field: PlanField) => `a:plf:${id}:${field}`,
  planNew: 'a:pl+',

  stats: 'a:st',
  statsTop: 'a:st:top',
  statsMissed: 'a:st:miss',

  broadcasts: 'a:bc',
  broadcastNew: (segment: string) => `a:bc+:${segment}`,
  broadcast: (id: number) => `a:bc1:${id}`,
  broadcastSend: (id: number) => `a:bc2:${id}`,
  broadcastStop: (id: number) => `a:bc3:${id}`,
  broadcastDrop: (id: number) => `a:bc4:${id}`,

  user: (id: number) => `a:u:${id}`,
  userBan: (id: number) => `a:ub:${id}`,
  userGrant: (id: number) => `a:ug:${id}`,
} as const;

export type PlanField = 'title' | 'price' | 'days';
export type ChannelField = 'title' | 'link' | 'starts' | 'ends' | 'target';

/** Поле из `a:plf:42:price` или `a:spf:42:ends`. */
export const subFieldFrom = (data: string): string | undefined => data.split(':')[3];

/** Разбирает `a:card:42` → 42; `a:pick:42:603` → [42, 603]. */
export const idsFrom = (data: string): number[] =>
  data
    .split(':')
    .slice(2)
    .map(Number)
    .filter((n) => Number.isSafeInteger(n));

export const panelKeyboard = (draftCount: number): InlineKeyboard =>
  new InlineKeyboard()
    .text(draftCount > 0 ? `📥 Неоформленные (${draftCount})` : '📥 Неоформленные', admin.drafts)
    .row()
    .text('🎬 Опубликованные', admin.published)
    .row()
    .text('📢 Каналы спонсоров', admin.sponsors)
    .row()
    .text('⭐ Тарифы', admin.plans)
    .row()
    .text('📊 Статистика', admin.stats)
    .text('📣 Рассылка', admin.broadcasts)
    .row()
    .text('‹ В меню', 'nav:home');

export type EditField = 'name' | 'desc' | 'year' | 'poster';

/** Поле из `a:f:42:desc`. */
export const fieldFrom = (data: string): EditField | undefined => {
  const value = data.split(':')[3];
  return value === 'name' || value === 'desc' || value === 'year' || value === 'poster'
    ? value
    : undefined;
};

export const cardKeyboard = (filmId: number, isPublished: boolean): InlineKeyboard => {
  const kb = new InlineKeyboard();
  if (isPublished) kb.text('🚫 Снять с публикации', admin.unpublish(filmId));
  else kb.text('✅ Опубликовать', admin.publish(filmId));
  return kb
    .row()
    .text('✏️ Редактировать', admin.edit(filmId))
    .row()
    .text('🗑 Удалить', admin.confirmDelete(filmId))
    .row()
    .text('‹ К списку', admin.panel);
};

export const editKeyboard = (filmId: number, tmdbAvailable: boolean): InlineKeyboard => {
  const kb = new InlineKeyboard();
  if (tmdbAvailable) kb.text('🔍 Заполнить из TMDB', admin.fill(filmId)).row();
  return kb
    .text('📝 Название', admin.field(filmId, 'name'))
    .text('📅 Год', admin.field(filmId, 'year'))
    .row()
    .text('📄 Описание', admin.field(filmId, 'desc'))
    .text('🖼 Постер', admin.field(filmId, 'poster'))
    .row()
    .text('🎭 Жанры', admin.genresScreen(filmId))
    .row()
    .text('‹ К карточке', admin.card(filmId));
};

export const genresKeyboard = (
  filmId: number,
  all: { id: number; nameRu: string }[],
  selected: number[],
): InlineKeyboard => {
  const kb = new InlineKeyboard();
  all.forEach((genre, i) => {
    const mark = selected.includes(genre.id) ? '✅ ' : '';
    kb.text(`${mark}${genre.nameRu}`, admin.toggleGenre(filmId, genre.id));
    // По два жанра в ряд — иначе список на 18 позиций не помещается на экран.
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('‹ Готово', admin.edit(filmId));
};
