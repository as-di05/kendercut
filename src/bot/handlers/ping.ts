import type { Bot } from 'grammy';
import type { BotContext } from '../context.js';

export function registerPing(bot: Bot<BotContext>): void {
  bot.command('ping', async (ctx) => {
    const uptime = Math.round(process.uptime());
    const role = ctx.isAdmin ? 'админ' : 'пользователь';

    await ctx.reply(
      [
        'pong 🏓',
        `ваш id: <code>${ctx.from?.id}</code>`,
        `роль: ${role}`,
        `аптайм: ${uptime} с`,
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });
}
