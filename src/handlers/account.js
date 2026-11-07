import { Composer, InlineKeyboard } from 'grammy';
import * as db from '../db.js';
import { createClient, friendlyError } from '../binance.js';
import { escapeHtml, isPrivate, mention } from '../utils.js';
import { getAllWallets } from '../wallets.js';
import { checkWithdrawPermission, outboundIp, whitelistText } from '../transfer.js';
import { showTravelInfo } from './travelinfo.js';

const composer = new Composer();

const MAX_ASSETS_PER_WALLET = 15;

// telegramId -> { step: 'key' | 'secret', apiKey?: string }
const pendingConnect = new Map();

const HELP = `<b>Quick Binance</b> — tip, send and receive crypto between Binance accounts.

<b>Account</b>
/connect — link your Binance account (private chat)
/disconnect — unlink your Binance account
/balance — show all your wallet balances (in groups they are hidden behind a spoiler)
/myid — show your Binance ID so others can tip you
/ip — the IP to whitelist on your Binance API key
/travelinfo — save your legal name &amp; country so users from Travel Rule regions (e.g. Binance India) can tip you

<b>Receive</b>
/deposit &lt;token&gt; — get your deposit address, e.g. <code>/deposit usdt</code>

<b>Withdraw</b>
<code>/withdraw &lt;amount&gt; &lt;token&gt; &lt;address&gt; [memo]</code> — send to any address (private chat), e.g. <code>/withdraw 25 usdt TXyz…</code>. Use <code>max</code> as the amount to send everything. You pick the network; 🟢 marks the one detected from the address.

<b>Tip / send</b>
Reply to someone's message:
<code>/bn 10 usdt Take a gift from me</code>
Or send to a Binance ID (or @username):
<code>/bn 10 usdt 123456789 Thanks!</code>
<code>/binance</code> works the same as <code>/bn</code>.

/history — your recent tips and withdrawals`;

const sendHelp = (ctx) => ctx.reply(HELP, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

// Callback data for this file: acct:<action>:<telegram id of the user the buttons belong to>
const btn = (ctx, label, action, style) => ({ ...InlineKeyboard.text(label, `acct:${action}:${ctx.from.id}`), ...(style && { style }) });

function connectButton(ctx, label = '🔗 Connect Binance') {
  return isPrivate(ctx)
    ? btn(ctx, label, 'connect', 'primary')
    : { ...InlineKeyboard.url(label, `https://t.me/${ctx.me.username}?start=connect`), style: 'primary' };
}

composer.command('start', async (ctx) => {
  if (isPrivate(ctx)) db.markStartedBot(ctx.from.id);
  if (isPrivate(ctx) && ctx.match === 'connect') return startConnect(ctx);
  if (isPrivate(ctx) && ctx.match === 'travelinfo') return showTravelInfo(ctx);

  const user = db.getUser(ctx.from.id);
  const connected = db.isConnected(user);
  const status = connected
    ? `✅ Your Binance account is connected (ID <code>${escapeHtml(user.binance_uid)}</code>).`
    : '🔗 Connect your Binance account to get started.';

  const kb = new InlineKeyboard();
  if (!connected) kb.add(connectButton(ctx));
  kb.add(btn(ctx, '📖 How to use', 'help'));

  await ctx.reply(
    `👋 <b>Welcome to Quick Binance, ${escapeHtml(ctx.from.first_name)}!</b>

Send, receive and tip crypto to other Binance users right here in Telegram.

🎁 <b>Tip</b> anyone by replying to their message with <code>/bn 10 usdt Thanks!</code>
📥 <b>Receive</b> with <code>/deposit usdt</code>
💼 <b>Check</b> all your wallets with /balance

${status}`,
    { parse_mode: 'HTML', reply_markup: kb },
  );
});

composer.command('help', sendHelp);

composer.command('connect', async (ctx) => {
  if (!isPrivate(ctx)) {
    return ctx.reply('For your safety, connect your Binance account in a private chat with me.', {
      reply_markup: new InlineKeyboard().add(connectButton(ctx, 'Connect in private chat')),
    });
  }
  return startConnect(ctx);
});

/** Begin the connect flow. When already connected, say so unless the user chose to replace their keys. */
async function startConnect(ctx, { replace = false } = {}) {
  db.markStartedBot(ctx.from.id);

  const user = db.getUser(ctx.from.id);
  const ip = await outboundIp();
  if (db.isConnected(user) && !replace) {
    const kb = copyIpKeyboard(ip)
      .row()
      .add(btn(ctx, '🔄 Replace API keys', 'reconnect', 'primary'))
      .add(btn(ctx, '🔌 Disconnect', 'disc', 'danger'));
    const permission = await checkWithdrawPermission(createClient(db.getCredentials(user)), user.telegram_id);
    return ctx.reply(
      `✅ You're already connected.\nBinance ID: <code>${escapeHtml(user.binance_uid)}</code>\n` +
        `Sending tips and withdrawals: ${permission.ok ? 'enabled' : `<b>disabled</b>\n\n${permission.message}`}` +
        (ip ? `\n\n🌐 IP to whitelist on your API key: <code>${escapeHtml(ip)}</code>` : ''),
      { parse_mode: 'HTML', reply_markup: kb },
    );
  }

  pendingConnect.set(ctx.from.id, { step: 'key' });
  await ctx.reply(
    `<b>Connect your Binance account</b>

1. Open Binance → Profile → <b>API Management</b> → Create API (System generated).
2. Enable <b>Enable Reading</b>. To send tips or withdraw, also enable <b>Enable Withdrawals</b> and choose <b>Restrict access to trusted IPs only</b> with this IP: <code>${escapeHtml(ip || "your bot server's public IP")}</code> (or send /ip any time)
3. To let tips and withdrawals use money in your other wallets:
   • Funding / Futures → enable <b>Permits Universal Transfer</b>
   • Flexible Earn → enable <b>Enable Spot &amp; Margin Trading</b> (Binance requires it to redeem Earn; the bot never places trades)
4. Do <b>not</b> enable <b>Enable Futures</b> or margin loan permissions; the bot doesn't need them.

Now send me your <b>API Key</b>. (Send /cancel to stop.)
I'll delete your messages containing keys right after reading them, and keys are stored encrypted.`,
    { parse_mode: 'HTML', reply_markup: copyIpKeyboard(ip) },
  );
}

/** A keyboard with a "Copy IP" button when the IP is known (empty otherwise). */
const copyIpKeyboard = (ip) => (ip ? new InlineKeyboard().copyText('📋 Copy IP', ip).primary() : new InlineKeyboard());

composer.command(['ip', 'whitelist'], async (ctx) => {
  const ip = await outboundIp();
  await ctx.reply(await whitelistText(), { parse_mode: 'HTML', reply_markup: copyIpKeyboard(ip) });
});

composer.command('cancel', async (ctx) => {
  if (pendingConnect.delete(ctx.from.id)) return ctx.reply('Cancelled.');
  return ctx.reply('Nothing to cancel.');
});

function askDisconnect(ctx) {
  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) return ctx.reply("You don't have a Binance account connected.");
  const kb = new InlineKeyboard().add(btn(ctx, '✅ Yes, disconnect', 'disc_yes', 'danger')).add(btn(ctx, '❌ No, keep it', 'disc_no', 'success'));
  return ctx.reply(
    `Disconnect Binance ID <code>${escapeHtml(user.binance_uid)}</code>?\n\n` +
      "Your API keys will be deleted and you won't be able to send or receive tips until you connect again.",
    { parse_mode: 'HTML', reply_markup: kb },
  );
}

composer.command('disconnect', askDisconnect);

composer.callbackQuery(/^acct:(\w+):(\d+)$/, async (ctx) => {
  const [, action, ownerId] = ctx.match;
  if (Number(ownerId) !== ctx.from.id) {
    return ctx.answerCallbackQuery({ text: 'These buttons are not for you.', show_alert: true });
  }
  await ctx.answerCallbackQuery();

  switch (action) {
    case 'help':
      return sendHelp(ctx);
    case 'connect':
      return startConnect(ctx);
    case 'reconnect':
      await ctx.editMessageReplyMarkup().catch(() => {});
      return startConnect(ctx, { replace: true });
    case 'disc':
      await ctx.editMessageReplyMarkup().catch(() => {});
      return askDisconnect(ctx);
    case 'disc_no':
      return ctx.editMessageText('👍 Your Binance account is still connected.');
    case 'disc_yes':
      pendingConnect.delete(ctx.from.id);
      db.removeConnection(ctx.from.id);
      return ctx.editMessageText(
        '🔌 Your Binance account has been disconnected and your API keys were deleted from Quick Binance. ' +
          'You may also want to delete the API key in Binance → API Management.',
      );
  }
});

composer.command('myid', async (ctx) => {
  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) return ctx.reply('You have not connected Binance yet. Use /connect in a private chat with me.');
  await ctx.reply(`Your Binance ID: <code>${escapeHtml(user.binance_uid)}</code>`, { parse_mode: 'HTML' });
});

composer.command('balance', async (ctx) => {
  const inGroup = !isPrivate(ctx);
  const replyOpts = inGroup ? { reply_parameters: { message_id: ctx.message.message_id } } : {};
  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) {
    return ctx.reply('You have not connected Binance yet.', {
      ...replyOpts,
      reply_markup: new InlineKeyboard().add(connectButton(ctx)),
    });
  }

  const status = await ctx.reply('⏳ Loading your wallets…', replyOpts);
  try {
    const { totals, quote, wallets } = await getAllWallets(createClient(db.getCredentials(user)));
    const sections = [];

    if (totals.length) {
      const decimals = quote === 'USDT' ? 2 : 8;
      const lines = totals.map((t) => `${escapeHtml(t.walletName)}: <b>${Number(t.balance).toFixed(decimals)}</b> ${quote}`);
      const sum = totals.reduce((s, t) => s + Number(t.balance), 0);
      lines.push(`<b>Total: ${sum.toFixed(decimals)} ${quote}</b>`);
      sections.push(`<b>💼 Overview</b> (estimated value)\n${lines.join('\n')}`);
    }

    for (const w of wallets) {
      if (!w.assets.length) continue;
      const lines = w.assets.slice(0, MAX_ASSETS_PER_WALLET).map((a) => {
        const extra = a.extra ? ` <i>(${escapeHtml(a.extra)})</i>` : '';
        return `• <b>${escapeHtml(a.asset)}</b>: ${escapeHtml(a.amount)}${extra}`;
      });
      if (w.assets.length > MAX_ASSETS_PER_WALLET) lines.push(`…and ${w.assets.length - MAX_ASSETS_PER_WALLET} more`);
      sections.push(`<b>${escapeHtml(w.name)}</b>\n${lines.join('\n')}`);
    }

    if (!sections.length) sections.push('All your Binance wallets are empty.');
    sections.push('<i>Tips and withdrawals use Spot first, then your other wallets.</i>');

    // Telegram messages max out at 4096 chars; drop whole wallet sections rather than cutting HTML mid-tag.
    const wrap = (body) =>
      inGroup ? `💼 <b>Balances of ${mention(user)}</b> <i>(tap to reveal)</i>\n<tg-spoiler>${body}</tg-spoiler>` : body;
    while (sections.length > 2 && wrap(sections.join('\n\n')).length > 4096) sections.splice(-2, 1);

    await ctx.api.editMessageText(ctx.chat.id, status.message_id, wrap(sections.join('\n\n')), {
      parse_mode: 'HTML',
    });
  } catch (err) {
    await ctx.api.editMessageText(ctx.chat.id, status.message_id, friendlyError(err));
  }
});

// Handle the API key / secret replies during /connect.
composer.chatType('private').on('message:text', async (ctx, next) => {
  const state = pendingConnect.get(ctx.from.id);
  if (!state || ctx.message.text.startsWith('/')) return next();

  const value = ctx.message.text.trim();
  await ctx.deleteMessage().catch(() => {});

  if (!/^[A-Za-z0-9]{32,128}$/.test(value)) {
    return ctx.reply("That doesn't look like a Binance API key/secret. Please try again, or /cancel.");
  }

  if (state.step === 'key') {
    pendingConnect.set(ctx.from.id, { step: 'secret', apiKey: value });
    return ctx.reply('Got the API Key (message deleted). Now send me your <b>Secret Key</b>.', { parse_mode: 'HTML' });
  }

  pendingConnect.delete(ctx.from.id);
  const credentials = { apiKey: state.apiKey, apiSecret: value };
  const status = await ctx.reply('Checking your keys with Binance…');

  try {
    const client = createClient(credentials);
    const account = await client.account();
    let restrictions = {};
    try {
      restrictions = await client.apiRestrictions();
    } catch {
      // Some keys can't read restrictions; treat withdrawals as unknown/disabled.
    }

    if (!account.uid) throw new Error('Binance did not return a UID for this account.');

    db.saveConnection(ctx.from.id, { ...credentials, uid: account.uid, canWithdraw: false });
    const permission = await checkWithdrawPermission(client, ctx.from.id);

    const warn = permission.ok
      ? ''
      : `\n\n⚠️ You can <b>receive</b> tips, but not send tips or /withdraw yet.\n\n${permission.message}`;
    // Spot & Margin Trading is needed to redeem Flexible Earn; Futures trading never is.
    const tradeWarn = restrictions.enableFutures
      ? '\n\n⚠️ This key has <b>Enable Futures</b> on. The bot does not need it — consider disabling it.'
      : '';

    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `✅ Connected! Your Binance ID: <code>${escapeHtml(account.uid)}</code>${warn}${tradeWarn}`,
      { parse_mode: 'HTML', reply_markup: permission.ok ? undefined : copyIpKeyboard(await outboundIp()) },
    );
  } catch (err) {
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `❌ Could not connect: ${escapeHtml(err.name === 'BinanceError' ? friendlyError(err) : err.message)}\nUse /connect to try again.`,
      { parse_mode: 'HTML' },
    );
  }
});

export default composer;
