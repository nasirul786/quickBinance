import { Composer, InlineKeyboard } from 'grammy';
import * as db from '../db.js';
import { createClient, getCoinConfig, friendlyError } from '../binance.js';
import { escapeHtml } from '../utils.js';

const composer = new Composer();

composer.command('deposit', async (ctx) => {
  const coin = ctx.match.trim().split(/\s+/)[0]?.toUpperCase();
  if (!coin) {
    return ctx.reply('Usage: <code>/deposit &lt;token&gt;</code>, e.g. <code>/deposit usdt</code>', { parse_mode: 'HTML' });
  }

  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) {
    return ctx.reply('You have not connected Binance yet. Use /connect in a private chat with me.');
  }

  try {
    const client = createClient(db.getCredentials(user));
    const coinCfg = await getCoinConfig(client, coin);
    if (!coinCfg) return ctx.reply(`Binance doesn't support the token ${coin}.`);

    const networks = coinCfg.networkList.filter((n) => n.depositEnable);
    if (!networks.length) return ctx.reply(`Deposits for ${coin} are currently disabled on all networks.`);

    const kb = new InlineKeyboard();
    networks.forEach((n, i) => {
      // Callback data: dep:<owner>:<coin>:<network>  (owner = who may press it)
      kb.text(n.name || n.network, `dep:${ctx.from.id}:${coin}:${n.network}`);
      if (i % 2 === 1) kb.row();
    });

    await ctx.reply(`Choose a network for depositing <b>${escapeHtml(coin)}</b>:`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  } catch (err) {
    await ctx.reply(friendlyError(err));
  }
});

composer.callbackQuery(/^dep:(\d+):([A-Z0-9]+):([A-Za-z0-9_-]+)$/, async (ctx) => {
  const [, ownerId, coin, network] = ctx.match;
  if (Number(ownerId) !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'This menu is not for you. Use /deposit yourself.', show_alert: true });
  }

  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) {
    return ctx.answerCallbackQuery({ text: 'Your Binance account is no longer connected.', show_alert: true });
  }

  try {
    const client = createClient(db.getCredentials(user));
    const [addr, coinCfg] = await Promise.all([client.depositAddress(coin, network), getCoinConfig(client, coin)]);
    const net = coinCfg?.networkList.find((n) => n.network === network);

    let text = `<b>Deposit ${escapeHtml(coin)}</b> — network <b>${escapeHtml(net?.name || network)}</b>\n\n` +
      `Address:\n<code>${escapeHtml(addr.address)}</code>`;
    if (addr.tag) {
      text += `\n\nMemo / Tag (required!):\n<code>${escapeHtml(addr.tag)}</code>`;
    }
    if (net?.depositDesc) text += `\n\nℹ️ ${escapeHtml(net.depositDesc)}`;
    text += `\n\n⚠️ Only send ${escapeHtml(coin)} on the ${escapeHtml(net?.name || network)} network to this address.`;

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(text, { parse_mode: 'HTML' });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true });
  }
});

export default composer;
