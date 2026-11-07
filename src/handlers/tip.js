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
  receivedAmount,
  checkWithdrawPermission,
  sendFromAllWallets,
  TransferError,
  travelRuleCountry,
  TRAVEL_RULE_FORMS,
  tipQuestionnaire,
  isTravelRuleError,
  enableInternalTransfers,
  limitError,
} from '../transfer.js';
import { hasTravelInfo } from './travelinfo.js';
import { escapeHtml, mention, splitArgs } from '../utils.js';

const composer = new Composer();

const USAGE = `<b>How to tip</b>
Reply to a message: <code>/bn &lt;amount&gt; &lt;token&gt; &lt;note&gt;</code>
e.g. <code>/bn 10 usdt Take a gift from me</code>

Without replying: <code>/bn &lt;amount&gt; &lt;token&gt; &lt;binance id&gt; &lt;note&gt;</code>
e.g. <code>/bn 10 usdt 123456789 Thanks!</code>`;

const MAX_NOTE = 200;

/** The user being replied to, ignoring forum-topic "root" replies that Telegram adds automatically. */
function repliedUser(msg) {
  const reply = msg.reply_to_message;
  if (!reply || reply.forum_topic_created) return null;
  if (msg.is_topic_message && reply.message_id === msg.message_thread_id) return null;
  return reply.from ?? null;
}

function connectKeyboard(ctx) {
  return new InlineKeyboard().url('🔗 Connect Binance', `https://t.me/${ctx.me.username}?start=connect`).primary();
}

const usableNetworks = (coinCfg) => withdrawNetworks(coinCfg, { needDeposit: true });

function header(tip, sender, recipient) {
  return (
    `<b>Tip</b> ${mention(sender)} → ${mention(recipient)}\n` +
    `Amount: <b>${escapeHtml(tip.amount)} ${escapeHtml(tip.coin)}</b>` +
    (tip.note ? `\nNote: ${escapeHtml(tip.note)}` : '')
  );
}

const footer = (sender) =>
  `\n\nOnly ${mention(sender)} can use these buttons. Expires ${Math.round(config.tipConfirmTtlMs / 60000)} min after the tip was started.`;

// ---------- step 1: choose network ----------

function networkStep(tip, sender, recipient, coinCfg, notice = '') {
  const kb = new InlineKeyboard();
  for (const n of usableNetworks(coinCfg)) {
    const memo = supportsMemo(n) ? ' · 📝 memo' : '';
    kb.text(`${n.name || n.network} · fee ${networkFee(n)} ${tip.coin}${memo}`, `tip:n:${tip.id}:${n.network}`).row();
  }
  kb.text('❌ Cancel', `tip:no:${tip.id}`).danger();
  return {
    text: `${header(tip, sender, recipient)}${notice}\n\n<b>Choose a network:</b>${footer(sender)}`,
    reply_markup: kb,
  };
}

// ---------- step 2: how to pay the fee ----------

function feeStep(tip, sender, recipient, net, options, funds) {
  const fee = networkFee(net);
  const kb = new InlineKeyboard();
  const lines = [];
  for (const o of options) {
    const label =
      o.mode === 'deduct'
        ? `➖ Deduct fee — they get ${o.receive} ${tip.coin}`
        : `➕ Pay fee extra — you pay ${o.send} ${tip.coin}`;
    if (o.error) lines.push(`<s>${escapeHtml(label)}</s> — ${escapeHtml(o.error)}`);
    else kb.text(label, `tip:f:${tip.id}:${o.mode}`).primary().row();
  }
  kb.text('◀️ Back', `tip:b:${tip.id}`).text('❌ Cancel', `tip:no:${tip.id}`).danger();

  const unavailable = lines.length
    ? `\n\nNot available:\n${lines.join('\n')}${escapeHtml(blockedNote(funds.blocked, tip.coin))}`
    : '';
  return {
    text:
      `${header(tip, sender, recipient)}\nNetwork: ${escapeHtml(net.name || net.network)}\n` +
      `Network fee: <b>${escapeHtml(fee)} ${escapeHtml(tip.coin)}</b>\n\n` +
      `<b>How do you want to pay the fee?</b>${unavailable}${footer(sender)}`,
    reply_markup: kb,
  };
}

// ---------- step 3: confirm ----------

function confirmStep(tip, sender, recipient, net, option, plan) {
  const internal = option.mode === 'internal';
  const kb = new InlineKeyboard().text('✅ Confirm', `tip:ok:${tip.id}`).success().row();
  if (!internal) kb.text('◀️ Back', `tip:b:${tip.id}`);
  kb.text('❌ Cancel', `tip:no:${tip.id}`).danger();
  const fee = networkFee(net);
  const c = escapeHtml(tip.coin);
  const feeLine = internal
    ? '⚡ Internal Binance transfer: instant, no fee'
    : `Network fee: ${escapeHtml(fee)} ${c}` +
      (option.mode === 'deduct' ? ' (deducted from the tip)' : option.mode === 'extra' ? ' (paid by you)' : '');
  return {
    text:
      `${header(tip, sender, recipient)}\n` +
      `Network: ${escapeHtml(net.name || net.network)}\n` +
      feeLine +
      `\n\nYou pay: <b>${escapeHtml(option.send)} ${c}</b>\n` +
      `They receive: <b>${escapeHtml(option.receive)} ${c}</b>\n` +
      `Taken from: ${escapeHtml(describePlan(plan, tip.coin))}\n` +
      (tip.address_tag ? `Memo / Tag: <code>${escapeHtml(tip.address_tag)}</code> <i>(recipient's deposit memo, attached automatically)</i>\n` : '') +
      (tip.travel_country ? `📋 Travel Rule: the recipient's saved details will be sent to Binance.\n` : '') +
      (internal ? '' : `\n<i>If Binance settles this as an internal transfer, the fee is waived and returned to you.</i>`) +
      footer(sender),
    reply_markup: kb,
  };
}

/**
 * For an internal transfer: the first network (Binance's default first) that accepts this amount
 * and where the recipient has a deposit address. Returns { net, address } or null.
 */
async function pickInternalNetwork(coinCfg, amount, coin, recipientClient) {
  const candidates = usableNetworks(coinCfg)
    .filter((n) => !limitError(n, amount, coin))
    .sort((a, b) => Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault)) || cmp(a.withdrawMin || '0', b.withdrawMin || '0'));
  for (const net of candidates) {
    try {
      const address = await recipientClient.depositAddress(coin, net.network);
      if (address?.address) return { net, address };
    } catch {
      // Recipient can't receive on this network; try the next one.
    }
  }
  return null;
}

// ---------- /bn command ----------

composer.command(['bn', 'binance', 'tip', 'send'], async (ctx) => {
  const msg = ctx.message;
  const target = repliedUser(msg);

  const { parts, rest } = splitArgs(ctx.match || '', target ? 2 : 3);
  const [amountRaw, tokenRaw, recipientRaw] = parts;
  const note = rest.slice(0, MAX_NOTE);

  if (!amountRaw || !tokenRaw || (!target && !recipientRaw)) {
    return ctx.reply(USAGE, { parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id } });
  }
  if (!isValidAmount(amountRaw)) {
    return ctx.reply(`"${amountRaw}" is not a valid amount.`, { reply_parameters: { message_id: msg.message_id } });
  }
  if (!/^[A-Za-z0-9]{1,15}$/.test(tokenRaw)) {
    return ctx.reply(`"${tokenRaw}" is not a valid token.`, { reply_parameters: { message_id: msg.message_id } });
  }
  const amount = normalize(amountRaw);
  const coin = tokenRaw.toUpperCase();
  const replyOpts = { parse_mode: 'HTML', reply_parameters: { message_id: msg.message_id } };

  // ----- sender -----
  const sender = db.getUser(ctx.from.id);
  if (!db.isConnected(sender)) {
    return ctx.reply("You haven't connected your Binance account yet. Connect it in a private chat with me first.", {
      ...replyOpts,
      reply_markup: connectKeyboard(ctx),
    });
  }

  // ----- recipient -----
  let recipient;
  if (target) {
    if (target.is_bot) return ctx.reply("You can't tip a bot.", replyOpts);
    db.touchUser(target);
    recipient = db.getUser(target.id);
    if (!db.isConnected(recipient)) {
      return ctx.reply(
        `${mention(recipient)} has not connected their Binance account to Quick Binance yet, so they can't receive tips. ` +
          `Ask them to send /connect to @${escapeHtml(ctx.me.username)} in a private chat.`,
        replyOpts,
      );
    }
  } else if (/^\d{5,20}$/.test(recipientRaw)) {
    recipient = db.getUserByBinanceUid(recipientRaw);
    if (!db.isConnected(recipient)) {
      return ctx.reply(
        `Binance ID <code>${escapeHtml(recipientRaw)}</code> is not connected to Quick Binance, so the tip can't be sent. ` +
          `The owner needs to /connect their Binance account with @${escapeHtml(ctx.me.username)} first.`,
        replyOpts,
      );
    }
  } else if (/^@[A-Za-z0-9_]{4,32}$/.test(recipientRaw)) {
    recipient = db.getUserByUsername(recipientRaw);
    if (!db.isConnected(recipient)) {
      return ctx.reply(
        `${escapeHtml(recipientRaw)} has not connected their Binance account to Quick Binance yet, so they can't receive tips.`,
        replyOpts,
      );
    }
  } else {
    return ctx.reply(
      `"${escapeHtml(recipientRaw)}" is not a valid Binance ID. Reply to the person's message, or use their numeric Binance ID.\n\n${USAGE}`,
      replyOpts,
    );
  }

  if (recipient.telegram_id === sender.telegram_id || recipient.binance_uid === sender.binance_uid) {
    return ctx.reply("You can't tip yourself 🙂", replyOpts);
  }

  // ----- balance across wallets & network list -----
  const status = await ctx.reply('⏳ Preparing tip…', replyOpts);
  const editStatus = (text, extra = {}) =>
    ctx.api.editMessageText(ctx.chat.id, status.message_id, text, { parse_mode: 'HTML', ...extra });

  try {
    const client = createClient(db.getCredentials(sender));
    const permission = await checkWithdrawPermission(client, sender.telegram_id);
    if (!permission.ok) return editStatus(`❌ You can't send tips yet.\n\n${permission.message}`);

    const [coinCfg, funds, travelCountry, internal] = await Promise.all([
      getCoinConfig(client, coin),
      getSources(client, coin),
      travelRuleCountry(client),
      enableInternalTransfers(client),
    ]);
    const { total, blocked } = funds;
    if (travelCountry) {
      const form = TRAVEL_RULE_FORMS[travelCountry];
      if (!form) {
        return editStatus(
          `❌ Your Binance account is under a local entity (<code>${escapeHtml(travelCountry)}</code>) whose Travel Rule form ` +
            `the bot doesn't support yet, so tips can't be sent from it.`,
        );
      }
      if (!hasTravelInfo(recipient, form)) {
        if (recipient.started_bot) {
          await ctx.api
            .sendMessage(
              recipient.telegram_id,
              `${mention(sender)} wants to tip you, but Binance's Travel Rule requires your legal name and country for it. ` +
                'Send /travelinfo to add them, then ask them to tip again.',
              { parse_mode: 'HTML' },
            )
            .catch(() => {});
        }
        return editStatus(
          `📋 Your Binance account must send the recipient's details to Binance (Travel Rule), and ${mention(recipient)} ` +
            `hasn't saved them yet. ${mention(recipient)}, please send /travelinfo to @${escapeHtml(ctx.me.username)} ` +
            'in a private chat, then try the tip again.',
        );
      }
    }
    if (!coinCfg) return editStatus(`Binance doesn't support the token <b>${escapeHtml(coin)}</b>.`);

    if (cmp(total, amount) < 0) {
      return editStatus(
        `Insufficient ${escapeHtml(coin)}: you can use ${escapeHtml(total)} ${escapeHtml(coin)} across your wallets.` +
          escapeHtml(blockedNote(blocked, coin)),
      );
    }
    if (!usableNetworks(coinCfg).length) {
      return editStatus(`${escapeHtml(coin)} transfers are currently unavailable on every network.`);
    }

    const tipId = db.createTip({
      from_tg: sender.telegram_id,
      to_tg: recipient.telegram_id,
      coin,
      network: null,
      address: null,
      address_tag: null,
      amount,
      fee: null,
      note: note || null,
      chat_id: ctx.chat.id,
    });
    db.setTipMessage(tipId, status.message_id);
    if (travelCountry) db.updatePendingTip(tipId, { travel_country: travelCountry });

    // With Fast Withdraw on, Binance settles this internally (instant, no fee), so the network is a
    // formality: pick one automatically and go straight to confirmation.
    if (internal.ok) {
      const picked = await pickInternalNetwork(coinCfg, amount, coin, createClient(db.getCredentials(recipient)));
      if (picked) {
        const { net, address } = picked;
        db.updatePendingTip(tipId, {
          network: net.network,
          address: address.address,
          address_tag: address.tag || null,
          fee: '0',
          fee_mode: 'internal',
          send_amount: amount,
        });
        const option = { mode: 'internal', send: amount, receive: amount };
        const { text, reply_markup } = confirmStep(db.getTip(tipId), sender, recipient, net, option, planSources(funds.sources, amount));
        return editStatus(text, { reply_markup });
      }
    }

    const notice = internal.ok
      ? ''
      : `\n\n⚠️ Couldn't turn on Binance Fast Withdraw, so this tip goes on-chain and network fees apply.\n<i>${escapeHtml(internal.reason)}</i>`;
    const { text, reply_markup } = networkStep(db.getTip(tipId), sender, recipient, coinCfg, notice);
    await editStatus(text, { reply_markup });
  } catch (err) {
    await editStatus(`❌ ${escapeHtml(friendlyError(err))}`);
  }
});

// ---------- button handling ----------

/** Load a tip for a button press, making sure the presser owns it and it's still open. */
async function openTip(ctx, id) {
  const tip = db.getTip(Number(id));
  if (!tip) {
    await ctx.answerCallbackQuery({ text: 'Tip not found.', show_alert: true });
    return null;
  }
  if (tip.from_tg !== ctx.from.id) {
    await ctx.answerCallbackQuery({ text: 'Only the sender can use these buttons.', show_alert: true });
    return null;
  }
  if (tip.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: `This tip is already ${tip.status}.` });
    return null;
  }
  if (Date.now() - tip.created_at > config.tipConfirmTtlMs) {
    db.transitionTip(tip.id, 'pending', 'expired');
    await ctx.answerCallbackQuery({ text: 'This tip expired. Send the command again.', show_alert: true });
    await ctx.editMessageText('⌛ Tip expired. Send the command again.').catch(() => {});
    return null;
  }
  return { tip, sender: db.getUser(tip.from_tg), recipient: db.getUser(tip.to_tg) };
}

const edit = (ctx, { text, reply_markup }) => ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup });

/** Load what every step needs: the chosen network's config and the sender's total balance. */
async function loadNetwork(tip, sender, network) {
  const client = createClient(db.getCredentials(sender));
  const [coinCfg, funds] = await Promise.all([getCoinConfig(client, tip.coin), getSources(client, tip.coin)]);
  const net = coinCfg && usableNetworks(coinCfg).find((n) => n.network === network);
  return { client, coinCfg, net, funds };
}

// Network picked → fetch recipient's address, then ask how to pay the fee.
composer.callbackQuery(/^tip:n:(\d+):([A-Za-z0-9_-]+)$/, async (ctx) => {
  const open = await openTip(ctx, ctx.match[1]);
  if (!open) return;
  const { tip, sender, recipient } = open;

  try {
    const { net, funds } = await loadNetwork(tip, sender, ctx.match[2]);
    if (!net) return ctx.answerCallbackQuery({ text: 'That network is no longer available.', show_alert: true });

    let address;
    try {
      address = await createClient(db.getCredentials(recipient)).depositAddress(tip.coin, net.network);
    } catch {
      address = null;
    }
    if (!address?.address) {
      return ctx.answerCallbackQuery({
        text: `The recipient can't receive ${tip.coin} on ${net.network}. Pick another network.`,
        show_alert: true,
      });
    }

    const fee = networkFee(net);
    db.updatePendingTip(tip.id, {
      network: net.network,
      address: address.address,
      address_tag: address.tag || null,
      fee,
      fee_mode: null,
      send_amount: null,
    });
    const updated = db.getTip(tip.id);
    const options = feeOptions(updated, net, funds.total);
    if (options.every((o) => o.error)) {
      return ctx.answerCallbackQuery({
        text: `Can't use ${net.network}: ${[...new Set(options.map((o) => o.error))].join('; ')}${blockedHint(funds)}`.slice(0, 190),
        show_alert: true,
      });
    }
    await ctx.answerCallbackQuery();

    // No fee → nothing to choose; go straight to confirmation.
    if (options[0].mode === 'none') {
      const o = options[0];
      db.updatePendingTip(tip.id, { fee_mode: 'none', send_amount: o.send });
      return edit(ctx, confirmStep(updated, sender, recipient, net, o, planSources(funds.sources, o.send)));
    }
    await edit(ctx, feeStep(updated, sender, recipient, net, options, funds));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

// Fee option picked → show the final confirmation.
composer.callbackQuery(/^tip:f:(\d+):(deduct|extra)$/, async (ctx) => {
  const open = await openTip(ctx, ctx.match[1]);
  if (!open) return;
  const { tip, sender, recipient } = open;

  try {
    const { net, funds } = await loadNetwork(tip, sender, tip.network);
    if (!net) return ctx.answerCallbackQuery({ text: 'That network is no longer available.', show_alert: true });

    const option = feeOptions(tip, net, funds.total).find((o) => o.mode === ctx.match[2]);
    if (!option || option.error) {
      return ctx.answerCallbackQuery({ text: `Not possible: ${option?.error ?? 'unknown option'}`, show_alert: true });
    }

    db.updatePendingTip(tip.id, { fee: networkFee(net), fee_mode: option.mode, send_amount: option.send });
    await ctx.answerCallbackQuery();
    await edit(ctx, confirmStep(db.getTip(tip.id), sender, recipient, net, option, planSources(funds.sources, option.send)));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

// Back → network list.
composer.callbackQuery(/^tip:b:(\d+)$/, async (ctx) => {
  const open = await openTip(ctx, ctx.match[1]);
  if (!open) return;
  const { tip, sender, recipient } = open;

  try {
    const coinCfg = await getCoinConfig(createClient(db.getCredentials(sender)), tip.coin);
    db.updatePendingTip(tip.id, { fee_mode: null, send_amount: null });
    await ctx.answerCallbackQuery();
    await edit(ctx, networkStep(tip, sender, recipient, coinCfg));
  } catch (err) {
    await ctx.answerCallbackQuery({ text: friendlyError(err).slice(0, 190), show_alert: true }).catch(() => {});
  }
});

composer.callbackQuery(/^tip:no:(\d+)$/, async (ctx) => {
  const open = await openTip(ctx, ctx.match[1]);
  if (!open) return;
  const { tip, sender, recipient } = open;
  if (db.transitionTip(tip.id, 'pending', 'cancelled')) {
    await ctx.answerCallbackQuery({ text: 'Tip cancelled.' });
    return ctx.editMessageText(`🚫 Tip cancelled.\n${header(tip, sender, recipient)}`, { parse_mode: 'HTML' });
  }
  return ctx.answerCallbackQuery({ text: 'This tip can no longer be cancelled.' });
});

// Confirm → gather funds into Spot, then withdraw.
composer.callbackQuery(/^tip:ok:(\d+)$/, async (ctx) => {
  const open = await openTip(ctx, ctx.match[1]);
  if (!open) return;
  const { tip, sender, recipient } = open;

  if (!tip.network || !tip.fee_mode || !tip.send_amount) {
    return ctx.answerCallbackQuery({ text: 'Choose a network and fee option first.', show_alert: true });
  }

  // Claim the tip so a double-tap can't send twice.
  if (!db.transitionTip(tip.id, 'pending', 'processing')) {
    return ctx.answerCallbackQuery({ text: 'This tip is already being processed.' });
  }
  await ctx.answerCallbackQuery({ text: 'Sending…' });
  await ctx.editMessageText(`⏳ Sending tip…\n${header(tip, sender, recipient)}`, { parse_mode: 'HTML' }).catch(() => {});

  const fail = async (reason) => {
    db.transitionTip(tip.id, 'processing', 'failed', { error: reason });
    await ctx.editMessageText(`❌ Tip failed: ${escapeHtml(reason)}\n${header(tip, sender, recipient)}`, { parse_mode: 'HTML' });
  };

  if (!db.isConnected(sender) || !db.isConnected(recipient)) return fail('one of the accounts is no longer connected.');

  const form = tip.travel_country && TRAVEL_RULE_FORMS[tip.travel_country];
  if (form && !hasTravelInfo(recipient, form)) return fail("the recipient removed their Travel Rule details (/travelinfo).");

  try {
    const client = createClient(db.getCredentials(sender));
    const result = await sendFromAllWallets(client, {
      coin: tip.coin,
      network: tip.network,
      address: tip.address,
      addressTag: tip.address_tag,
      amount: tip.send_amount,
      orderId: `qb${tip.id}`,
      questionnaire: form ? await tipQuestionnaire(client, recipient) : null,
    });
    db.transitionTip(tip.id, 'processing', 'sent', { withdrawId: result.id });

    const receive = receivedAmount(tip);
    const noteLine = tip.note ? `\n💬 ${escapeHtml(tip.note)}` : '';
    await ctx.editMessageText(
      `🎁 ${mention(sender)} tipped ${mention(recipient)} <b>${escapeHtml(receive)} ${escapeHtml(tip.coin)}</b>!${noteLine}`,
      { parse_mode: 'HTML' },
    );

    if (recipient.started_bot) {
      await ctx.api
        .sendMessage(
          recipient.telegram_id,
          `🎁 You received <b>${escapeHtml(receive)} ${escapeHtml(tip.coin)}</b> from ${mention(sender)} on Binance.${noteLine}`,
          { parse_mode: 'HTML' },
        )
        .catch(() => {});
    }
  } catch (err) {
    let reason = err instanceof TransferError ? err.message : friendlyError(err);
    if (!form && isTravelRuleError(err)) {
      reason += ' The bot could not detect which Travel Rule form your account needs.';
    }
    await fail(reason);
  }
});

// Tips are withdrawals to the recipient's deposit address, so both are listed together.
composer.command('history', async (ctx) => {
  const me = ctx.from.id;
  const tips = db
    .listTipsForUser(me, 15)
    .filter((t) => t.from_tg === me || t.status === 'sent') // failed incoming tips never reached you
    .map((t) => ({ kind: 'tip', at: t.created_at, row: t }));
  const withdrawals = db.listWithdrawalsForUser(me, 15).map((w) => ({ kind: 'withdraw', at: w.created_at, row: w }));
  const items = [...tips, ...withdrawals].sort((a, b) => b.at - a.at).slice(0, 15);
  if (!items.length) return ctx.reply('No tips or withdrawals yet.');

  const short = (addr) => (addr.length > 14 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr);
  const lines = items.map(({ kind, at, row }) => {
    const date = new Date(at).toISOString().slice(0, 16).replace('T', ' ');
    const failed = row.status === 'failed';
    const amount = `${escapeHtml(row.send_amount || row.amount)} ${escapeHtml(row.coin)}`;
    const net = row.network ? ` · ${escapeHtml(row.network)}` : '';
    if (kind === 'withdraw') {
      return `${failed ? '❌' : '🏦'} ${date} Withdraw ${amount} → <code>${escapeHtml(short(row.address))}</code>${net}`;
    }
    const outgoing = row.from_tg === me;
    const other = db.getUser(outgoing ? row.to_tg : row.from_tg);
    if (!outgoing) {
      const received = row.send_amount ? receivedAmount(row) : row.amount;
      return `📥 ${date} Tip from ${mention(other)} +${escapeHtml(received)} ${escapeHtml(row.coin)}${net}`;
    }
    return `${failed ? '❌' : '📤'} ${date} Tip to ${mention(other)} ${amount}${net}`;
  });
  await ctx.reply(`<b>Recent activity</b>\n${lines.join('\n')}\n\n<i>🏦 withdraw · 📤 tip sent · 📥 tip received · ❌ failed · times in UTC</i>`, {
    parse_mode: 'HTML',
  });
});

export default composer;
