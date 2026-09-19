import { InlineKeyboard } from 'grammy';

/** Значения callback_data. Держим в одном месте, чтобы не разъезжались с обработчиками. */
export const nav = {
  home: 'nav:home',
  catalog: 'nav:catalog',
  search: 'nav:search',
  subscription: 'nav:subscription',
  profile: 'nav:profile',
  invite: 'nav:invite',
  admin: 'nav:admin',
} as const;

export function mainMenu(isAdmin: boolean): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text('🎬 Каталог', nav.catalog)
    .text('🔍 Поиск', nav.search)
    .row()
    .text('⭐ Подписка', nav.subscription)
    .text('👤 Профиль', nav.profile)
    .row()
    .text('🎁 Пригласить друга', nav.invite);

  if (isAdmin) kb.row().text('🛠 Админка', nav.admin);

  return kb;
}

export const backToMenu = new InlineKeyboard().text('‹ В меню', nav.home);
