import { cmp, normalize } from './decimal.js';

const nonZero = (v) => v !== undefined && v !== null && cmp(String(v), '0') !== 0;

// Each loader returns [{ asset, amount, extra? }] for one wallet.
const LOADERS = [
  {
    name: 'Spot',
    load: async (c) => {
      const acc = await c.account();
      return acc.balances.map((b) => ({
        asset: b.asset,
        amount: normalize(b.free),
        extra: nonZero(b.locked) ? `locked ${normalize(b.locked)}` : '',
      }));
    },
  },
  {
    name: 'Funding',
    load: async (c) =>
      (await c.fundingAssets()).map((b) => ({
        asset: b.asset,
        amount: normalize(b.free),
        extra: nonZero(b.locked) || nonZero(b.freeze) ? `locked ${normalize(b.locked)}, frozen ${normalize(b.freeze)}` : '',
      })),
  },
  {
    name: 'Earn (Flexible)',
    load: async (c) =>
      (await c.flexibleEarn()).rows.map((r) => ({ asset: r.asset, amount: normalize(r.totalAmount) })),
  },
  {
    name: 'Earn (Locked)',
    load: async (c) =>
      (await c.lockedEarn()).rows.map((r) => ({ asset: r.asset, amount: normalize(r.amount) })),
  },
  {
    name: 'Cross Margin',
    load: async (c) =>
      (await c.crossMargin()).userAssets.map((a) => ({
        asset: a.asset,
        amount: normalize(a.netAsset),
        extra: nonZero(a.borrowed) ? `borrowed ${normalize(a.borrowed)}` : '',
      })),
  },
  {
    name: 'USDⓈ-M Futures',
    load: async (c) =>
      (await c.usdmFutures()).map((b) => ({
        asset: b.asset,
        amount: normalize(b.balance),
        extra: nonZero(b.crossUnPnl) ? `PnL ${normalize(b.crossUnPnl)}` : '',
      })),
  },
  {
    name: 'COIN-M Futures',
    load: async (c) =>
      (await c.coinmFutures()).map((b) => ({
        asset: b.asset,
        amount: normalize(b.balance),
        extra: nonZero(b.crossUnPnl) ? `PnL ${normalize(b.crossUnPnl)}` : '',
      })),
  },
];

function sortAssets(rows) {
  return rows
    .filter((r) => nonZero(r.amount) || r.extra)
    .sort((a, b) => cmp(b.amount, a.amount));
}

/**
 * Fetch every wallet in parallel. Wallets the API key can't read (e.g. futures not opened) are skipped.
 * Returns { totals: [{ walletName, balance }], quote, wallets: [{ name, assets }] }.
 */
export async function getAllWallets(client) {
  const totalsPromise = client
    .walletBalances('USDT')
    .then((rows) => ({ rows, quote: 'USDT' }))
    .catch(() => client.walletBalances().then((rows) => ({ rows, quote: 'BTC' })))
    .catch(() => ({ rows: [], quote: null }));

  const results = await Promise.allSettled(LOADERS.map((l) => l.load(client)));
  const wallets = LOADERS.map((l, i) => ({
    name: l.name,
    assets: results[i].status === 'fulfilled' ? sortAssets(results[i].value) : [],
    error: results[i].status === 'rejected' ? results[i].reason : null,
  }));

  // Binance mirrors Simple Earn Flexible positions into the spot account as "LD<asset>" (e.g. LDUSDT).
  // They're already listed under Earn (Flexible), so drop them from Spot.
  const flexible = wallets.find((w) => w.name === 'Earn (Flexible)');
  const ldAssets = new Set(flexible.assets.map((a) => `LD${a.asset}`));
  wallets[0].assets = wallets[0].assets.filter((a) => !ldAssets.has(a.asset));

  const { rows, quote } = await totalsPromise;
  const totals = rows.filter((r) => Number(r.balance) > 0);

  // If even the spot account failed, the key itself is the problem — surface that error.
  if (wallets[0].error) throw wallets[0].error;

  return { totals, quote, wallets };
}
