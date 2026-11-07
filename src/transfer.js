import { add, cmp, isMultipleOf, normalize, sub } from './decimal.js';
import { getSources, planSources, gatherToSpot } from './funding.js';
import { proxiedFetch } from './proxy.js';
import * as db from './db.js';

// Shared by tips and /withdraw: network rules, fee options, permission check and the send itself.

/** Networks you can withdraw on. Tips also need the recipient side to accept deposits. */
export const withdrawNetworks = (coinCfg, { needDeposit = false } = {}) =>
  coinCfg.networkList.filter((n) => n.withdrawEnable && (!needDeposit || n.depositEnable));

export const networkFee = (net) => normalize(net.withdrawFee || '0');

/** True when the network takes a memo/tag (XRP, XLM, TON, ...). */
export const supportsMemo = (net) => Boolean(net.memoRegex) || Boolean(net.sameAddress);

/** Does `address` fit this network's address format? null when Binance gives no pattern. */
export function addressMatches(net, address) {
  if (!net.addressRegex) return null;
  try {
    return new RegExp(net.addressRegex).test(address);
  } catch {
    return null;
  }
}

/** Why Binance would refuse to withdraw `send` on this network, or null if it's fine. */
export function limitError(net, send, coin) {
  if (cmp(send, net.withdrawMin || '0') < 0) return `minimum on ${net.network} is ${net.withdrawMin} ${coin}`;
  if (Number(net.withdrawMax) && cmp(send, net.withdrawMax) > 0) return `maximum on ${net.network} is ${net.withdrawMax} ${coin}`;
  if (!isMultipleOf(send, net.withdrawIntegerMultiple || '0')) {
    return `amount on ${net.network} must be a multiple of ${net.withdrawIntegerMultiple}`;
  }
  return null;
}

/**
 * The ways the network fee can be paid, each with whether it's possible right now:
 * deduct (recipient gets amount - fee), extra (sender pays amount + fee), or none when the fee is 0.
 */
export function feeOptions({ amount, coin }, net, totalAvailable) {
  const fee = networkFee(net);
  const check = (send) =>
    limitError(net, send, coin) ?? (cmp(totalAvailable, send) < 0 ? `you only have ${totalAvailable} ${coin} in total` : null);

  if (cmp(fee, '0') === 0) {
    return [{ mode: 'none', send: amount, receive: amount, error: check(amount) }];
  }
  return [
    {
      mode: 'deduct',
      send: amount,
      receive: sub(amount, fee),
      error: cmp(amount, fee) <= 0 ? `the fee (${fee} ${coin}) is more than the amount` : check(amount),
    },
    { mode: 'extra', send: add(amount, fee), receive: amount, error: check(add(amount, fee)) },
  ];
}

/** What arrives at the destination: the amount sent to Binance minus the network fee. */
export const receivedAmount = (row) => sub(row.send_amount, row.fee || '0');

let cachedIp = null;

/** The public IP Binance sees for this bot (the proxy's IP when the proxy is on). */
export async function outboundIp() {
  if (cachedIp) return cachedIp;
  try {
    cachedIp = (await (await proxiedFetch('https://api.ipify.org')).text()).trim();
  } catch {
    cachedIp = null;
  }
  return cachedIp;
}

/**
 * Ask Binance, right now, whether this key may withdraw, and remember the answer.
 * Returns { ok: true } or { ok: false, message } with instructions to fix it.
 */
export async function checkWithdrawPermission(client, telegramId) {
  let r;
  try {
    r = await client.apiRestrictions();
  } catch {
    return { ok: true }; // Can't tell; let Binance decide when the withdrawal is made.
  }

  // Binance only honours API withdrawals on keys restricted to trusted IPs.
  const ok = Boolean(r.enableWithdrawals && r.ipRestrict);
  if (telegramId) db.setCanWithdraw(telegramId, ok);
  if (ok) return { ok };

  const ip = await outboundIp();
  const ipText = ip ? `<code>${ip}</code>` : "this bot server's public IP";
  if (!r.ipRestrict) {
    return {
      ok: false,
      message:
        'Your API key allows access from <b>any IP</b>, and Binance blocks API withdrawals on such keys.\n\n' +
        'In Binance → API Management → <b>Edit restrictions</b>:\n' +
        `1. Choose <b>Restrict access to trusted IPs only</b> and add ${ipText}\n` +
        '2. Make sure <b>Enable Withdrawals</b> is ticked\n' +
        '3. Save. There is no need to /connect again.',
    };
  }
  return {
    ok: false,
    message:
      '<b>Enable Withdrawals</b> is not ticked on your API key.\n\n' +
      `In Binance → API Management → <b>Edit restrictions</b>, tick it and make sure ${ipText} is in the trusted IP list. ` +
      'There is no need to /connect again.',
  };
}

/**
 * Make sure Binance settles withdrawals to other Binance users internally (free, instant).
 * Returns { ok: true } or { ok: false, reason }.
 */
export async function enableInternalTransfers(client) {
  try {
    await client.enableFastWithdraw();
    return { ok: true };
  } catch (err) {
    const hint = err.code === -2015 || /permission|authorized/i.test(err.message || '')
      ? ' Tick "Enable Spot & Margin Trading" on your API key to allow it.'
      : '';
    return { ok: false, reason: `${(err.message || 'Unknown error').replace(/\.?$/, '.')}${hint}` };
  }
}

// ---------- Travel Rule ----------

/**
 * Travel rule forms the bot can fill in, by questionnaireCountryCode. These entities share one
 * schema (isAddressOwner, bnfType, bnfName, country, city, sendTo, vasp, vaspName); they differ
 * only in whether the beneficiary's city is required.
 */
export const TRAVEL_RULE_FORMS = {
  IN: { cityRequired: false }, // Binance India
  AE: { cityRequired: true }, // Binance UAE
};

/** The travel rule form this account must send, e.g. "IN", or null when withdrawals need none. */
export async function travelRuleCountry(client) {
  try {
    const { questionnaireCountryCode: code } = await client.questionnaireRequirements();
    if (!code || /^nil$/i.test(code)) return null;
    return code.toUpperCase();
  } catch {
    return null; // Accounts outside a local entity can't use this endpoint.
  }
}

/** Build the questionnaire object Binance expects from the answers collected in chat. */
export function buildQuestionnaire(a) {
  const q = { isAddressOwner: a.isAddressOwner, sendTo: a.sendTo };
  if (a.isAddressOwner === 2) {
    q.bnfType = a.bnfType;
    q.bnfName = a.bnfName;
    q.country = a.country;
    if (a.city) q.city = a.city;
  }
  if (a.sendTo === 2) {
    q.vasp = a.vasp;
    if (a.vasp === 'others') q.vaspName = a.vaspName;
  }
  return q;
}

/** Travel rule answers for a tip: the beneficiary is another Binance user, so the VASP is Binance itself. */
export async function tipQuestionnaire(client, recipient) {
  let binance = null;
  try {
    binance = (await client.vaspList()).find((v) => v.vaspCode?.toUpperCase() === 'BINANCE' || /^binance$/i.test(v.vaspName || ''));
  } catch {
    // Fall back to naming Binance as an unlisted VASP.
  }
  return buildQuestionnaire({
    isAddressOwner: 2,
    bnfType: 0,
    bnfName: recipient.legal_name,
    country: recipient.legal_country,
    city: recipient.legal_city || undefined,
    sendTo: 2,
    vasp: binance?.identifier ?? 'others',
    vaspName: 'Binance',
  });
}

export class TransferError extends Error {}

/**
 * Gather `amount` into Spot from all wallets (Spot first), then withdraw it.
 * With a travel rule `questionnaire`, the withdrawal goes through Binance's travel rule API.
 * Returns { id }. Throws TransferError with a user-facing message for funding problems; Binance errors pass through.
 */
export async function sendFromAllWallets(client, { coin, network, address, addressTag, amount, orderId, questionnaire }) {
  const { sources, state } = await getSources(client, coin);
  const plan = planSources(sources, amount);
  if (!plan) throw new TransferError(`not enough ${coin} across your wallets any more.`);

  try {
    await gatherToSpot(client, coin, plan, amount, state);
  } catch (err) {
    throw new TransferError(`${err.message} Any amount already moved is now in your Spot wallet.`);
  }

  const params = { coin, network, address, addressTag, amount, withdrawOrderId: orderId };
  if (!questionnaire) return client.withdraw(params);

  const r = await client.travelRuleWithdraw({ ...params, questionnaire });
  if (r.accepted === false) throw new TransferError(`Binance did not accept the travel rule details: ${r.info || 'no reason given'}.`);
  return { id: String(r.trId) };
}

/** Binance's message when an account needs the travel rule form but a plain withdrawal was sent. */
export const isTravelRuleError = (err) => /travel rule/i.test(err?.message || '');
