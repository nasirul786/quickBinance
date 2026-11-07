import { BinanceError } from './binance.js';
import { add, cmp, normalize, sub } from './decimal.js';

// API key permissions needed to move money out of a wallet (field in /account/apiRestrictions → label in Binance UI).
const PERMISSIONS = {
  permitsUniversalTransfer: 'Permits Universal Transfer',
  enableSpotAndMarginTrading: 'Enable Spot & Margin Trading',
};

// Wallets a tip can be paid from, in the order they are used. Spot always comes first because
// withdrawals are made from Spot; any shortfall is moved into Spot from the others.
const SOURCES = [
  {
    key: 'spot',
    label: 'Spot',
    available: async (c, coin) => (await c.account()).balances.find((b) => b.asset === coin)?.free ?? '0',
  },
  {
    key: 'funding',
    label: 'Funding',
    available: async (c, coin) => (await c.fundingAssets()).find((b) => b.asset === coin)?.free ?? '0',
    needs: 'permitsUniversalTransfer',
    moveToSpot: (c, coin, amount) => c.universalTransfer('FUNDING_MAIN', coin, amount),
  },
  {
    key: 'earn',
    label: 'Earn (Flexible)',
    available: async (c, coin, state) => {
      const row = (await c.flexibleEarn()).rows.find((r) => r.asset === coin && r.canRedeem !== false);
      state.earnProductId = row?.productId;
      return row?.totalAmount ?? '0';
    },
    // Binance treats Simple Earn redemption as a TRADE request.
    needs: 'enableSpotAndMarginTrading',
    moveToSpot: (c, coin, amount, state) => c.redeemFlexible(state.earnProductId, amount),
  },
  {
    key: 'usdm',
    label: 'USDⓈ-M Futures',
    available: async (c, coin) => {
      const b = (await c.usdmFutures()).find((x) => x.asset === coin);
      return b?.maxWithdrawAmount ?? b?.availableBalance ?? '0';
    },
    needs: 'permitsUniversalTransfer',
    moveToSpot: (c, coin, amount) => c.universalTransfer('UMFUTURE_MAIN', coin, amount),
  },
  {
    key: 'coinm',
    label: 'COIN-M Futures',
    available: async (c, coin) => (await c.coinmFutures()).find((x) => x.asset === coin)?.withdrawAvailable ?? '0',
    needs: 'permitsUniversalTransfer',
    moveToSpot: (c, coin, amount) => c.universalTransfer('CMFUTURE_MAIN', coin, amount),
  },
];

/**
 * How much of `coin` each wallet can contribute. Wallets the key can't read are skipped,
 * except Spot: if Spot fails the key itself is broken, so that error is thrown.
 * Wallets holding the coin that the key isn't permitted to move from go in `blocked`, not in the total.
 */
export async function getSources(client, coin) {
  const state = {};
  const [restrictions, ...results] = await Promise.allSettled([
    client.apiRestrictions(),
    ...SOURCES.map((s) => s.available(client, coin, state)),
  ]);
  if (results[0].status === 'rejected') throw results[0].reason;
  // If permissions can't be read, assume allowed and let Binance decide.
  const allowed = (field) => restrictions.status !== 'fulfilled' || Boolean(restrictions.value[field]);

  const sources = [];
  const blocked = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const amount = normalize(String(r.value));
    if (cmp(amount, '0') <= 0) return;
    const src = SOURCES[i];
    if (src.needs && !allowed(src.needs)) blocked.push({ ...src, amount, permission: PERMISSIONS[src.needs] });
    else sources.push({ ...src, amount });
  });
  const total = sources.reduce((sum, s) => add(sum, s.amount), '0');
  return { sources, blocked, total, state };
}

/** Short version for alert popups (200 chars max). */
export const blockedHint = (funds) =>
  funds.blocked.length ? ` (${funds.blocked.map((b) => `${b.label} needs "${b.permission}"`).join(', ')})` : '';

/** e.g. "Earn (Flexible) 50 USDT — tick "Enable Spot & Margin Trading" on your API key". Plain text; escape for HTML. */
export function blockedNote(blocked, coin) {
  if (!blocked.length) return '';
  const lines = blocked.map((b) => `• ${b.label} ${b.amount} ${coin} — tick "${b.permission}" on your API key`);
  return `\n\nNot usable yet:\n${lines.join('\n')}\n(Binance → API Management → Edit restrictions)`;
}

/** Take from wallets in order until `need` is covered. Returns null if they don't add up. */
export function planSources(sources, need) {
  const plan = [];
  let left = normalize(need);
  for (const s of sources) {
    if (cmp(left, '0') <= 0) break;
    const take = cmp(s.amount, left) >= 0 ? left : s.amount;
    plan.push({ ...s, take });
    left = sub(left, take);
  }
  return cmp(left, '0') > 0 ? null : plan;
}

export const describePlan = (plan, coin) => plan.map((p) => `${p.label} ${p.take} ${coin}`).join(' + ');

/**
 * Move every non-spot part of the plan into Spot, then wait until Spot holds `need`.
 * Throws a BinanceError naming the wallet that failed; anything already moved stays in Spot.
 */
export async function gatherToSpot(client, coin, plan, need, state) {
  for (const p of plan) {
    if (!p.moveToSpot) continue;
    try {
      await p.moveToSpot(client, coin, p.take, state);
    } catch (err) {
      const hint = p.needs && (err.code === -1002 || /not authorized/i.test(err.message))
        ? ` Tick "${PERMISSIONS[p.needs]}" on your API key.`
        : '';
      throw new BinanceError(`Couldn't move ${p.take} ${coin} from ${p.label} to Spot: ${err.message}${hint}`, {
        code: err.code,
        status: err.status,
      });
    }
  }

  if (plan.every((p) => !p.moveToSpot)) return;

  // Transfers and Earn redemptions usually land within a second or two.
  for (let i = 0; i < 15; i++) {
    const free = (await client.account()).balances.find((b) => b.asset === coin)?.free ?? '0';
    if (cmp(free, need) >= 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new BinanceError(`Funds moved to Spot haven't arrived yet. Please try the tip again in a minute.`);
}
