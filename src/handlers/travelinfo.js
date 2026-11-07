import { Composer, InlineKeyboard } from 'grammy';
import * as db from '../db.js';
import { escapeHtml, isPrivate } from '../utils.js';

// /travelinfo — the legal name, country and city a user shares so that people whose Binance account
// falls under the Travel Rule (e.g. Binance India) can tip them. Binance requires the beneficiary's
// details on those transfers.

const composer = new Composer();

// telegramId -> { step: 'name' | 'country' | 'city', name?, country? }
const pending = new Map();

const EXPLAIN =
  'Some Binance accounts (e.g. Binance India) must send the recipient\'s <b>legal name and country</b> to Binance ' +
  'with every transfer (the Travel Rule). If you save them here, those users can tip you. ' +
  'The details are only sent to Binance with tips you receive, and are never shown in chats.';

export const hasTravelInfo = (user, { cityRequired = false } = {}) =>
  Boolean(user?.legal_name && user?.legal_country && (!cityRequired || user?.legal_city));

function summary(user) {
  if (!hasTravelInfo(user)) return 'You have <b>not</b> saved Travel Rule details yet.';
  return (
    `Saved details:\nName: <b>${escapeHtml(user.legal_name)}</b>\n` +
    `Country: <b>${escapeHtml(user.legal_country.toUpperCase())}</b>\n` +
    `City: <b>${escapeHtml(user.legal_city || '—')}</b>`
  );
}

composer.command('travelinfo', async (ctx) => {
  if (!isPrivate(ctx)) {
    return ctx.reply('Please use /travelinfo in a private chat with me.', {
      reply_markup: new InlineKeyboard().url('Open private chat', `https://t.me/${ctx.me.username}?start=travelinfo`).primary(),
    });
  }
  return showTravelInfo(ctx);
});

export async function showTravelInfo(ctx) {
  const user = db.getUser(ctx.from.id);
  const kb = new InlineKeyboard().text(hasTravelInfo(user) ? '✏️ Change' : '➕ Add details', `ti:set:${ctx.from.id}`).primary();
  if (hasTravelInfo(user)) kb.text('🗑 Remove', `ti:del:${ctx.from.id}`).danger();
  await ctx.reply(`📋 <b>Travel Rule details</b>\n\n${EXPLAIN}\n\n${summary(user)}`, { parse_mode: 'HTML', reply_markup: kb });
}

composer.callbackQuery(/^ti:(set|del|skip):(\d+)$/, async (ctx) => {
  const [, action, ownerId] = ctx.match;
  if (Number(ownerId) !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'These buttons are not for you.', show_alert: true });
  await ctx.answerCallbackQuery();

  if (action === 'del') {
    pending.delete(ctx.from.id);
    db.setTravelInfo(ctx.from.id, {});
    return ctx.editMessageText('🗑 Your Travel Rule details were removed.');
  }
  if (action === 'skip') {
    const state = pending.get(ctx.from.id);
    if (state?.step !== 'city') return;
    return save(ctx, { ...state, city: null });
  }
  pending.set(ctx.from.id, { step: 'name' });
  await ctx.editMessageReplyMarkup().catch(() => {});
  await ctx.reply('What is your <b>full legal name</b>, as on your Binance account? (/cancel to stop)', { parse_mode: 'HTML' });
});

async function save(ctx, { name, country, city }) {
  pending.delete(ctx.from.id);
  db.setTravelInfo(ctx.from.id, { name, country, city });
  await ctx.reply(`✅ Saved. People can now tip you from Travel Rule accounts.\n\n${summary(db.getUser(ctx.from.id))}`, {
    parse_mode: 'HTML',
  });
}

composer.command('cancel', async (ctx, next) => {
  if (!pending.delete(ctx.from.id)) return next();
  await ctx.reply('Cancelled.');
});

composer.chatType('private').on('message:text', async (ctx, next) => {
  const state = pending.get(ctx.from.id);
  if (!state || ctx.message.text.startsWith('/')) return next();
  const value = ctx.message.text.trim();

  if (state.step === 'name') {
    if (!/^[\p{L}][\p{L} .,'-]{1,99}$/u.test(value)) return ctx.reply('Please send your full legal name using letters only.');
    pending.set(ctx.from.id, { step: 'country', name: value });
    return ctx.reply('Which <b>country</b> do you live in? Send the 2-letter code, e.g. <code>in</code>, <code>ae</code>.', {
      parse_mode: 'HTML',
    });
  }
  if (state.step === 'country') {
    if (!/^[A-Za-z]{2}$/.test(value)) return ctx.reply('Please send a 2-letter country code, e.g. in, ae, us.');
    pending.set(ctx.from.id, { ...state, step: 'city', country: value.toLowerCase() });
    return ctx.reply('Which <b>city</b>? (Some Binance entities, like UAE, require it.)', {
      parse_mode: 'HTML',
      reply_markup: new InlineKeyboard().text('Skip', `ti:skip:${ctx.from.id}`),
    });
  }
  if (!/^[\p{L}][\p{L} .'-]{1,59}$/u.test(value)) return ctx.reply('Please send the city name, or tap Skip.');
  return save(ctx, { ...state, city: value });
});

export default composer;
