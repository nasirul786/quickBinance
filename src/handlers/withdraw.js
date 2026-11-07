import { Composer, InlineKeyboard } from 'grammy';
import * as db from '../db.js';
import { config } from '../config.js';
import { createClient, getCoinConfig, friendlyError } from '../binance.js';
import { isValidAmount, normalize, cmp } from '../decimal.js';
import { getSources, planSources, describePlan, blockedNote, blockedHint } from '../funding.js';
import {
  withdrawNetworks,
  feeOptions,
  networkFee,
  supportsMemo,
  addressMatches,
  receivedAmount,
  checkWithdrawPermission,
  sendFromAllWallets,
  TransferError,
  travelRuleCountry,
  TRAVEL_RULE_FORMS,
  buildQuestionnaire,
  isTravelRuleError,
  enableInternalTransfers,
} from '../transfer.js';
import { escapeHtml, isPrivate, splitArgs } from '../utils.js';

const composer = new Composer();

const USAGE = `<b>Withdraw</b>
<code>/withdraw &lt;amount&gt; &lt;token&gt; &lt;address&gt; [memo]</code>
e.g. <code>/withdraw 25 usdt TXyz…abc</code>
or <code>/withdraw 50 xrp rEb8…xyz 123456</code>
Use <code>max</code> as the amount to withdraw everything.`;

const isMax = (amount) => amount === 'max';

// Travel rule answers being collected: withdrawal id -> answers so far
const travelAnswers = new Map();
// telegramId -> { id, field } while waiting for a typed travel rule answer
const awaitingText = new Map();

// ---------- rendering ----------

function header(w, net) {
  return (
    `<b>Withdraw ${isMax(w.amount) ? 'all' : escapeHtml(w.amount)} ${escapeHtml(w.coin)}</b>\n` +
    `To: <code>${escapeHtml(w.address)}</code>` +
    (w.memo ? `\nMemo: <code>${escapeHtml(w.memo)}</code>` : '') +
    (net ? `\nNetwork: ${escapeHtml(net.name || net.network)}` : '')
  );
}

const footer = () => `\n\n<i>Expires ${Math.round(config.tipConfirmTtlMs / 60000)} min after you started.</i>`;

function networkStep(w, coinCfg) {
  const networks = withdrawNetworks(coinCfg)
    .map((n) => ({ n, match: addressMatches(n, w.address) }))
    .sort((a, b) => Number(b.match === true) - Number(a.match === true));

  const kb = new InlineKeyboard();
  for (const { n, match } of networks) {
    const dot = match === true ? '🟢 ' : '';
    const memo = supportsMemo(n) ? ' · 📝 memo' : '';
    kb.text(`${dot}${n.name || n.network} · fee ${networkFee(n)} ${w.coin}${memo}`, `wd:n:${w.id}:${n.network}`);
    if (match === true) kb.success(); // detected from the address
    kb.row();
  }
  kb.text('❌ Cancel', `wd:no:${w.id}`).danger();

  const anyMatch = networks.some((x) => x.match === true);
  const hint = anyMatch
    ? '🟢 = detected from your address'
    : `⚠️ This address doesn't match any ${escapeHtml(w.coin)} network format Binance knows. Double-check it.`;
  return { text: `${header(w)}\n\n<b>Choose a network:</b>\n${hint}${footer()}`, reply_markup: kb };
}

function feeStep(w, net, options, funds) {
  const kb = new InlineKeyboard();
  const lines = [];
  for (const o of options) {
    const label =
      o.mode === 'deduct' ? `➖ Deduct fee — address gets ${o.receive} ${w.coin}` : `➕ Pay fee extra — you pay ${o.send} ${w.coin}`;
    if (o.error) lines.push(`<s>${escapeHtml(label)}</s> — ${escapeHtml(o.error)}`);
    else kb.text(label, `wd:f:${w.id}:${o.mode}`).primary().row();
  }
  kb.text('◀️ Back', `wd:b:${w.id}`).text('❌ Cancel', `wd:no:${w.id}`).danger();
  const unavailable = lines.length
    ? `\n\nNot available:\n${lines.join('\n')}${escapeHtml(blockedNote(funds.blocked, w.coin))}`
    : '';
  return {
    text:
      `${header(w, net)}\nNetwork fee: <b>${escapeHtml(networkFee(net))} ${escapeHtml(w.coin)}</b>\n\n` +
      `<b>How do you want to pay the fee?</b>${unavailable}${footer()}`,
    reply_markup: kb,
  };
}

function memoNote(w, net) {
  if (w.memo && !supportsMemo(net)) return `\nℹ️ ${escapeHtml(net.network)} doesn't use a memo, so yours won't be sent.`;
  if (!w.memo && supportsMemo(net)) {
    return `\n⚠️ <b>No memo.</b> If this address belongs to an exchange, funds sent without its memo can be lost.`;
  }
  return '';
}

/** One line per travel rule answer, for the confirm screen. */
function travelSummary(w) {
  if (!w.questionnaire) return '';
  const { q, vaspLabel } = JSON.parse(w.questionnaire);
  const owner =
    q.isAddressOwner === 1
      ? 'you'
      : `${q.bnfName} (${q.bnfType === 1 ? 'company' : 'individual'}, ${q.country.toUpperCase()}${q.city ? `, ${q.city}` : ''})`;
  const where = q.sendTo === 1 ? 'private wallet' : `exchange — ${vaspLabel || q.vaspName}`;
  return `\n\n📋 <b>Travel Rule</b>\nOwner: ${escapeHtml(owner)}\nAddress is a: ${escapeHtml(where)}`;
}

function confirmStep(w, net, option, plan) {
  const kb = new InlineKeyboard()
    .text('✅ Confirm withdrawal', `wd:ok:${w.id}`)
    .success()
    .row()
    .text('◀️ Back', `wd:b:${w.id}`)
    .text('❌ Cancel', `wd:no:${w.id}`)
    .danger();
  const c = escapeHtml(w.coin);
  return {
    text:
      `${header(w, net)}\n` +
      `Network fee: ${escapeHtml(networkFee(net))} ${c}` +
      (option.mode === 'deduct' ? ' (deducted)' : option.mode === 'extra' ? ' (paid on top)' : '') +
      `\n\nYou pay: <b>${escapeHtml(option.send)} ${c}</b>\n` +
      `Address receives: <b>${escapeHtml(option.receive)} ${c}</b>\n` +
      `Taken from: ${escapeHtml(describePlan(plan, w.coin))}` +
      memoNote(w, net) +
      travelSummary(w) +
      `\n\n⚠️ Withdrawals can't be undone. Check the address and network.${footer()}`,
    reply_markup: kb,
  };
}

// ---------- travel rule questions ----------

const TR_INTRO = '📋 <b>Travel Rule</b> — Binance requires these details for withdrawals from your account.\n\n';

/**
 * The next unanswered travel rule question for this withdrawal, or null when all are answered.
 * Typed questions register `awaitingText` so the next message from the user answers them.
 */
function nextQuestion(ctx, w, a) {
  const form = TRAVEL_RULE_FORMS[w.travel_country];
  const kb = new InlineKeyboard();
  const cancel = () => kb.row().text('◀️ Back', `wd:b:${w.id}`).text('❌ Cancel', `wd:no:${w.id}`).danger();
  const ask = (question) => ({ text: `${header(w)}\n\n${TR_INTRO}<b>${question}</b>${footer()}`, reply_markup: kb });
  const askText = (field, question) => {
    awaitingText.set(ctx.from.id, { id: w.id, field });
    cancel();
    return ask(`${question}\n\n<i>Send it as a message.</i>`);
  };

  if (a.isAddressOwner === undefined) {
    kb.text('👤 Me', `wd:q:${w.id}:o:1`).primary().text('👥 Someone else', `wd:q:${w.id}:o:2`).primary();
    cancel();
    return ask('Who owns the receiving address?');
  }
  if (a.isAddressOwner === 2) {
    if (a.bnfType === undefined) {
      kb.text('🧑 Individual', `wd:q:${w.id}:t:0`).primary().text('🏢 Company', `wd:q:${w.id}:t:1`).primary();
      cancel();
      return ask('Is the owner a person or a company?');
    }
    if (!a.bnfName) return askText('bnfName', "What is the owner's full legal name?");
    if (!a.country) return askText('country', "Which country is the owner in? Send the 2-letter code, e.g. <code>in</code>, <code>ae</code>, <code>us</code>.");
    if (form.cityRequired && !a.city) return askText('city', 'Which city is the owner in?');
  }
  if (a.sendTo === undefined) {
    kb.text('🔐 Private wallet', `wd:q:${w.id}:s:1`).primary().text('🏦 Exchange', `wd:q:${w.id}:s:2`).primary();
    cancel();
    return ask('Where is the receiving address?');
  }
  if (a.sendTo === 2 && !a.vasp) {
    if (a.vaspMatches?.length) {
      a.vaspMatches.forEach((v, i) => kb.text(v.vaspName, `wd:q:${w.id}:v:${i}`).primary().row());
      kb.text('Not in this list', `wd:q:${w.id}:v:x`);
      cancel();
      return ask(`Which exchange did you mean by "${escapeHtml(a.vaspTyped)}"?`);
    }
    return askText('vasp', 'Which exchange is the address on? Send its name, e.g. <code>Binance</code>, <code>WazirX</code>, <code>CoinDCX</code>.');
  }
  return null;
}

// ---------- helpers ----------

/** Load a withdrawal for a button press or typed answer, making sure it's the user's and still open. */
async function openWithdrawal(ctx, id) {
  const say = (text) => (ctx.callbackQuery ? ctx.answerCallbackQuery({ text, show_alert: true }) : ctx.reply(text));
  const w = db.getWithdrawal(Number(id));
  if (!w || w.telegram_id !== ctx.from.id) {
    await say('Withdrawal not found.');
    return null;
  }
  if (w.status !== 'pending') {
    await say(`This withdrawal is already ${w.status}.`);
    return null;
  }
  if (Date.now() - w.created_at > config.tipConfirmTtlMs) {
    db.transitionWithdrawal(w.id, 'pending', 'expired');
    clearTravel(ctx.from.id, w.id);
    await say('This withdrawal expired. Send /withdraw again.');
    if (ctx.callbackQuery) await ctx.editMessageText('⌛ Withdrawal expired. Send /withdraw again.').catch(() => {});
    return null;
  }
  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) {
    await say('Your Binance account is no longer connected.');
    return null;
  }
  return { w, client: createClient(db.getCredentials(user)) };
}

function clearTravel(telegramId, id) {
  travelAnswers.delete(id);
  if (awaitingText.get(telegramId)?.id === id) awaitingText.delete(telegramId);
}

async function loadNetwork(client, w, network) {
  const [coinCfg, funds] = await Promise.all([getCoinConfig(client, w.coin), getSources(client, w.coin)]);
  const net = coinCfg && withdrawNetworks(coinCfg).find((n) => n.network === network);
  return { coinCfg, net, funds };
}

/** The fee options for this withdrawal; 'max' resolves to everything available right now. */
function optionsFor(w, net, funds) {
  const amount = isMax(w.amount) ? funds.total : w.amount;
  return feeOptions({ amount, coin: w.coin }, net, funds.total);
}

async function confirmFor(client, w) {
  const { net, funds } = await loadNetwork(client, w, w.network);
  if (!net) return { text: 'That network is no longer available. Send /withdraw again.' };
  const option = optionsFor(w, net, funds).find((o) => o.mode === w.fee_mode);
  if (!option || option.error) return { text: `❌ ${escapeHtml(option?.error ?? 'This option is no longer possible.')}` };
  return confirmStep(w, net, option, planSources(funds.sources, option.send));
}

/** After the fee is settled: ask travel rule questions if needed, otherwise show the confirmation. */
async function afterFee(ctx, client, w, show) {
  if (w.travel_country && !w.questionnaire) {
    if (!travelAnswers.has(w.id)) travelAnswers.set(w.id, {});
    const question = nextQuestion(ctx, w, travelAnswers.get(w.id));
    if (question) return show(question);
  }
  return show(await confirmFor(client, w));
}

/** Save the finished answers, or ask the next question. */
async function continueTravel(ctx, client, w, show) {
  const a = travelAnswers.get(w.id);
  const question = nextQuestion(ctx, w, a);
  if (question) return show(question);

  db.updatePendingWithdrawal(w.id, {
    questionnaire: JSON.stringify({ q: buildQuestionnaire(a), vaspLabel: a.vaspLabel ?? null }),
  });
  travelAnswers.delete(w.id);
  return show(await confirmFor(client, db.getWithdrawal(w.id)));
}

const edit = (ctx, { text, reply_markup }) => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup });
const reply = (ctx, { text, reply_markup }) => ctx.reply(text, { parse_mode: 'HTML', reply_markup });

// ---------- /withdraw ----------

composer.command('withdraw', async (ctx) => {
  if (!isPrivate(ctx)) return ctx.reply('For your safety, use /withdraw in a private chat with me.');

  const { parts, rest } = splitArgs(ctx.match || '', 3);
  const [amountRaw, tokenRaw, address] = parts;
  const memo = rest.split(/\s+/)[0] || null;
  if (!amountRaw || !tokenRaw || !address) return ctx.reply(USAGE, { parse_mode: 'HTML' });

  const amountInput = amountRaw.toLowerCase().replace(',', '.');
  if (!['max', 'all'].includes(amountInput) && !isValidAmount(amountInput)) {
    return ctx.reply(`"${amountRaw}" is not a valid amount.\n\n${USAGE}`, { parse_mode: 'HTML' });
  }
  if (!/^[A-Za-z0-9]{1,15}$/.test(tokenRaw)) return ctx.reply(`"${tokenRaw}" is not a valid token.\n\n${USAGE}`, { parse_mode: 'HTML' });
  if (!/^[A-Za-z0-9:._-]{10,128}$/.test(address)) return ctx.reply("That doesn't look like a valid address.");
  const amount = ['max', 'all'].includes(amountInput) ? 'max' : normalize(amountInput);
  const coin = tokenRaw.toUpperCase();

  const user = db.getUser(ctx.from.id);
  if (!db.isConnected(user)) return ctx.reply('You have not connected Binance yet. Use /connect first.');

  const status = await ctx.reply('⏳ Checking…');
  const editStatus = (text, extra = {}) =>
    ctx.api.editMessageText(ctx.chat.id, status.message_id, text, { parse_mode: 'HTML', ...extra });

  try {
    const client = createClient(db.getCredentials(user));
    const permission = await checkWithdrawPermission(client, user.telegram_id);
    if (!permission.ok) return editStatus(`❌ You can't withdraw yet.\n\n${permission.message}`);

    const [coinCfg, { total, blocked }, travelCountry] = await Promise.all([
      getCoinConfig(client, coin),
      getSources(client, coin),
      travelRuleCountry(client),
      // So that withdrawing to another Binance user's address is settled internally (free, instant).
      enableInternalTransfers(client),
    ]);
    if (travelCountry && !TRAVEL_RULE_FORMS[travelCountry]) {
      return editStatus(
        `❌ Your Binance account is under a local entity (<code>${escapeHtml(travelCountry)}</code>) whose Travel Rule form ` +
          `the bot doesn't support yet. Please withdraw in the Binance app for now.`,
      );
    }
    if (!coinCfg) return editStatus(`Binance doesn't support the token <b>${escapeHtml(coin)}</b>.`);
    if (!withdrawNetworks(coinCfg).length) return editStatus(`${escapeHtml(coin)} withdrawals are currently disabled on every network.`);
    if (isMax(amount) ? cmp(total, '0') <= 0 : cmp(total, amount) < 0) {
      return editStatus(
        `Insufficient ${escapeHtml(coin)}: you can use ${escapeHtml(total)} ${escapeHtml(coin)} across your wallets.` +
          escapeHtml(blockedNote(blocked, coin)),
      );
    }

    const id = db.createWithdrawal({ telegram_id: user.telegram_id, coin, address, memo, amount });
    if (travelCountry) db.updatePendingWithdrawal(id, { travel_country: travelCountry });
    const { text, reply_markup } = networkStep(db.getWithdrawal(id), coinCfg);
    await editStatus(text, { reply_markup });
  } catch (err) {
    await editStatus(`❌ ${escapeHtml(friendlyError(err))}`);
  }
});

// Network picked → ask how to pay the fee (skipped when there's no fee).
composer.callbackQuery(/^wd:n:(\d+):([A-Za-z0-9_-]+)$/, async (ctx) => {
  const open = await openWithdrawal(ctx, ctx.match[1]);
  if (!open) return;
  const { w, client } = open;

  try {
    const { net, funds } = await loadNetwork(client, w, ctx.match[2]);
    if (!net) return ctx.answerCallbackQuery({ text: 'That network is no longer available.', show_alert: true });

    if (addressMatches(net, w.address) === false) {
      return ctx.answerCallbackQuery({
        text: `This isn't a valid ${net.name || net.network} address. Pick the network that matches your address.`,
        show_alert: true,
      });
    }
    if (w.memo && net.memoRegex && !new RegExp(net.memoRegex).test(w.memo)) {
      return ctx.answerCallbackQuery({ text: `"${w.memo}" isn't a valid memo for ${net.network}.`, show_alert: true });
    }

    const options = optionsFor(w, net, funds);
    if (options.every((o) => o.error)) {
      return ctx.answerCallbackQuery({
        text: `Can't use ${net.network}: ${[...new Set(options.map((o) => o.error))].join('; ')}${blockedHint(funds)}`.slice(0, 190),
        show_alert: true,
      });
    }

    db.updatePendingWithdrawal(w.id, { network: net.network, fee: networkFee(net), fee_mode: null, send_amount: null });
    await ctx.answerCallbackQuery();

    if (options[0].mode === 'none') {
      db.updatePendingWithdrawal(w.id, { fee_mode: 'none', send_amount: options[0].send });
      return afterFee(ctx, client, db.getWithdrawal(w.id), (step) => edit(ctx, step));
    }
    await edit(ctx, feeStep(db.getWithdrawal(w.id), net, options, funds));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

composer.callbackQuery(/^wd:f:(\d+):(deduct|extra)$/, async (ctx) => {
  const open = await openWithdrawal(ctx, ctx.match[1]);
  if (!open) return;
  const { w, client } = open;
  try {
    const { net, funds } = await loadNetwork(client, w, w.network);
    if (!net) return ctx.answerCallbackQuery({ text: 'That network is no longer available.', show_alert: true });
    const option = optionsFor(w, net, funds).find((o) => o.mode === ctx.match[2]);
    if (!option || option.error) {
      return ctx.answerCallbackQuery({ text: `Not possible: ${option?.error ?? 'unknown option'}`, show_alert: true });
    }
    db.updatePendingWithdrawal(w.id, { fee: networkFee(net), fee_mode: option.mode, send_amount: option.send });
    await ctx.answerCallbackQuery();
    await afterFee(ctx, client, db.getWithdrawal(w.id), (step) => edit(ctx, step));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

// Travel rule button answers: o = owner, t = owner type, s = sendTo, v = VASP choice.
composer.callbackQuery(/^wd:q:(\d+):([otsv]):(\w+)$/, async (ctx) => {
  const open = await openWithdrawal(ctx, ctx.match[1]);
  if (!open) return;
  const { w, client } = open;
  const a = travelAnswers.get(w.id);
  if (!a) return ctx.answerCallbackQuery({ text: 'Please start again with /withdraw.', show_alert: true });

  const [, , key, value] = ctx.match;
  if (key === 'o') a.isAddressOwner = Number(value);
  if (key === 't') a.bnfType = Number(value);
  if (key === 's') a.sendTo = Number(value);
  if (key === 'v') {
    const picked = value === 'x' ? null : a.vaspMatches?.[Number(value)];
    if (picked) {
      a.vasp = picked.identifier;
      a.vaspLabel = picked.vaspName;
    } else {
      a.vasp = 'others';
      a.vaspName = a.vaspTyped;
    }
    delete a.vaspMatches;
  }
  await ctx.answerCallbackQuery();
  try {
    await continueTravel(ctx, client, w, (step) => edit(ctx, step));
  } catch (err) {
    await ctx.reply(`❌ ${escapeHtml(friendlyError(err))}`, { parse_mode: 'HTML' });
  }
});

// Travel rule typed answers.
composer.chatType('private').on('message:text', async (ctx, next) => {
  const waiting = awaitingText.get(ctx.from.id);
  if (!waiting || ctx.message.text.startsWith('/')) return next();

  const open = await openWithdrawal(ctx, waiting.id);
  if (!open) return awaitingText.delete(ctx.from.id);
  const { w, client } = open;
  const a = travelAnswers.get(w.id);
  if (!a) {
    awaitingText.delete(ctx.from.id);
    return ctx.reply('Please start again with /withdraw.');
  }

  const value = ctx.message.text.trim();
  try {
    if (waiting.field === 'bnfName') {
      if (!/^[\p{L}][\p{L} .,'&-]{1,99}$/u.test(value)) return ctx.reply('Please send the full legal name using letters only.');
      a.bnfName = value;
    } else if (waiting.field === 'country') {
      if (!/^[A-Za-z]{2}$/.test(value)) return ctx.reply('Please send a 2-letter country code, e.g. in, ae, us.');
      a.country = value.toLowerCase();
    } else if (waiting.field === 'city') {
      if (!/^[\p{L}][\p{L} .'-]{1,59}$/u.test(value)) return ctx.reply('Please send the city name.');
      a.city = value;
    } else if (waiting.field === 'vasp') {
      if (value.length < 2 || value.length > 60) return ctx.reply('Please send the exchange name.');
      const needle = value.toLowerCase();
      const list = await client.vaspList();
      const exact = list.find((v) => [v.vaspName, v.vaspCode].some((s) => s?.toLowerCase() === needle));
      const matches = exact ? [exact] : list.filter((v) => [v.vaspName, v.vaspCode].some((s) => s?.toLowerCase().includes(needle)));
      a.vaspTyped = value;
      if (matches.length === 1) {
        a.vasp = matches[0].identifier;
        a.vaspLabel = matches[0].vaspName;
      } else if (matches.length > 1) {
        a.vaspMatches = matches.slice(0, 8);
      } else {
        a.vasp = 'others'; // Binance accepts unlisted exchanges by name.
        a.vaspName = value;
      }
    }
    awaitingText.delete(ctx.from.id);
    await continueTravel(ctx, client, w, (step) => reply(ctx, step));
  } catch (err) {
    await ctx.reply(`❌ ${escapeHtml(friendlyError(err))}`, { parse_mode: 'HTML' });
  }
});

composer.command('cancel', async (ctx, next) => {
  const waiting = awaitingText.get(ctx.from.id);
  if (!waiting) return next();
  clearTravel(ctx.from.id, waiting.id);
  db.transitionWithdrawal(waiting.id, 'pending', 'cancelled');
  await ctx.reply('Withdrawal cancelled.');
});

composer.callbackQuery(/^wd:b:(\d+)$/, async (ctx) => {
  const open = await openWithdrawal(ctx, ctx.match[1]);
  if (!open) return;
  const { w, client } = open;
  try {
    const coinCfg = await getCoinConfig(client, w.coin);
    clearTravel(ctx.from.id, w.id);
    db.updatePendingWithdrawal(w.id, { network: null, fee_mode: null, send_amount: null, questionnaire: null });
    await ctx.answerCallbackQuery();
    await edit(ctx, networkStep(db.getWithdrawal(w.id), coinCfg));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

composer.callbackQuery(/^wd:no:(\d+)$/, async (ctx) => {
  const w = db.getWithdrawal(Number(ctx.match[1]));
  if (!w || w.telegram_id !== ctx.from.id) return ctx.answerCallbackQuery({ text: 'Withdrawal not found.' });
  if (db.transitionWithdrawal(w.id, 'pending', 'cancelled')) {
    clearTravel(ctx.from.id, w.id);
    await ctx.answerCallbackQuery({ text: 'Cancelled.' });
    return ctx.editMessageText('🚫 Withdrawal cancelled.');
  }
  return ctx.answerCallbackQuery({ text: `This withdrawal is already ${w.status}.` });
});

// Confirm → gather funds into Spot, then withdraw.
composer.callbackQuery(/^wd:ok:(\d+)$/, async (ctx) => {
  const open = await openWithdrawal(ctx, ctx.match[1]);
  if (!open) return;
  const { w, client } = open;
  if (!w.network || !w.fee_mode || !w.send_amount || (w.travel_country && !w.questionnaire)) {
    return ctx.answerCallbackQuery({ text: 'Finish the steps above first.', show_alert: true });
  }
  if (!db.transitionWithdrawal(w.id, 'pending', 'processing')) {
    return ctx.answerCallbackQuery({ text: 'This withdrawal is already being processed.' });
  }
  await ctx.answerCallbackQuery({ text: 'Withdrawing…' });
  await ctx.editMessageText(`⏳ Withdrawing…\n${header(w)}`, { parse_mode: 'HTML' }).catch(() => {});

  try {
    const coinCfg = await getCoinConfig(client, w.coin);
    const net = coinCfg && withdrawNetworks(coinCfg).find((n) => n.network === w.network);
    if (!net) throw new TransferError(`${w.network} withdrawals are no longer available.`);

    const result = await sendFromAllWallets(client, {
      coin: w.coin,
      network: w.network,
      address: w.address,
      addressTag: supportsMemo(net) ? w.memo : null,
      amount: w.send_amount,
      orderId: `qbw${w.id}`,
      questionnaire: w.questionnaire ? JSON.parse(w.questionnaire).q : null,
    });
    db.transitionWithdrawal(w.id, 'processing', 'sent', { withdrawId: result.id });
    await ctx.editMessageText(
      `✅ <b>Withdrawal submitted</b>\n${header(w, net)}\n` +
        `You paid: <b>${escapeHtml(w.send_amount)} ${escapeHtml(w.coin)}</b>\n` +
        `Address receives: <b>${escapeHtml(receivedAmount(w))} ${escapeHtml(w.coin)}</b>\n` +
        `Binance reference: <code>${escapeHtml(result.id)}</code>\n\n` +
        `Track it in Binance → Wallet → Transaction History.`,
      { parse_mode: 'HTML' },
    );
  } catch (err) {
    let reason = err instanceof TransferError ? err.message : friendlyError(err);
    if (!w.questionnaire && isTravelRuleError(err)) {
      reason += ' The bot could not detect which Travel Rule form your account needs, so please withdraw in the Binance app for now.';
    }
    db.transitionWithdrawal(w.id, 'processing', 'failed', { error: reason });
    await ctx.editMessageText(`❌ Withdrawal failed: ${escapeHtml(reason)}\n${header(w)}`, { parse_mode: 'HTML' });
  }
});

export default composer;
