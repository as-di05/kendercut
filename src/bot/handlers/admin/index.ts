import { Composer } from 'grammy';
import { countDrafts } from '../../../db/repositories/films.js';
import type { BotContext } from '../../context.js';
import { admin, panelKeyboard } from '../../keyboards/admin.js';
import { nav } from '../../keyboards/main.js';
import { adminEdit } from './edit.js';
import { adminFilms } from './films.js';
import { adminGrant } from './grant.js';
import { adminBroadcast } from './broadcast.js';
import { adminPlans } from './plans.js';
import { adminRefund } from './refund.js';
import { adminSponsors } from './sponsors.js';
import { adminStats } from './stats.js';
import { adminUsers } from './users.js';

export const adminHandler = new Composer<BotContext>();

/**
 * Внутрь пускаем только администраторов.
 * Фильтр по ctx.isAdmin, а не по содержимому апдейта: у служебных апдейтов
 * (my_chat_member и подобных) нет ни отправителя, ни сессии, и попытка
 * заглянуть в session на них падает.
 */
const guarded = adminHandler.filter((ctx): boolean => ctx.isAdmin === true);

guarded.callbackQuery(nav.admin, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText('🛠 <b>Админка</b>\n\nВыберите раздел.', {
    parse_mode: 'HTML',
    reply_markup: panelKeyboard(await countDrafts()),
  });
});

guarded.use(adminGrant);
guarded.use(adminRefund);
guarded.use(adminPlans);
guarded.use(adminStats);
guarded.use(adminUsers);
guarded.use(adminBroadcast);
guarded.use(adminSponsors);
guarded.use(adminEdit);
guarded.use(adminFilms);

export { admin };
