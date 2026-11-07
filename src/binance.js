import crypto from 'node:crypto';
import { config } from './config.js';
import { proxiedFetch as fetch } from './proxy.js';

export class BinanceError extends Error {
  constructor(message, { code, status } = {}) {
    super(message);
    this.name = 'BinanceError';
    this.code = code;
    this.status = status;
  }
}

// Keep local clock in sync with Binance to avoid -1021 "Timestamp outside recvWindow".
let timeOffset = 0;
let lastSync = 0;

async function syncTime() {
  if (Date.now() - lastSync < 10 * 60 * 1000) return;
  try {
    const res = await fetch(`${config.binanceBaseUrl}/api/v3/time`);
    const { serverTime } = await res.json();
    timeOffset = serverTime - Date.now();
    lastSync = Date.now();
  } catch {
    // Fall back to local time; the request may still succeed.
  }
}

async function signedRequest({ apiKey, apiSecret }, method, endpoint, params = {}, baseUrl = config.binanceBaseUrl) {
  await syncTime();

  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') query.append(k, String(v));
  }
  query.append('recvWindow', '10000');
  query.append('timestamp', String(Date.now() + timeOffset));

  const signature = crypto.createHmac('sha256', apiSecret).update(query.toString()).digest('hex');
  query.append('signature', signature);

  const url = `${baseUrl}${endpoint}?${query.toString()}`;
  const res = await fetch(url, {
    method,
    headers: { 'X-MBX-APIKEY': apiKey },
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new BinanceError(`Unexpected response from Binance (HTTP ${res.status})`, { status: res.status });
  }

  if (!res.ok || (body && typeof body.code === 'number' && body.code < 0)) {
    throw new BinanceError(body?.msg || `Binance request failed (HTTP ${res.status})`, {
      code: body?.code,
      status: res.status,
    });
  }
  return body;
}

export function createClient(credentials) {
  const call = (method, endpoint, params, baseUrl) => signedRequest(credentials, method, endpoint, params, baseUrl);

  return {
    /** Spot account info. Includes `uid` and `balances`. */
    account: () => call('GET', '/api/v3/account', { omitZeroBalances: true }),

    /** API key permissions (enableWithdrawals, ipRestrict, ...). */
    apiRestrictions: () => call('GET', '/sapi/v1/account/apiRestrictions'),

    /** Every coin with its networks, fees and deposit/withdraw availability. */
    allCoins: () => call('GET', '/sapi/v1/capital/config/getall'),

    depositAddress: (coin, network) =>
      call('GET', '/sapi/v1/capital/deposit/address', { coin, network }),

    withdraw: ({ coin, network, address, addressTag, amount, withdrawOrderId }) =>
      call('POST', '/sapi/v1/capital/withdraw/apply', {
        coin,
        network,
        address,
        addressTag,
        amount,
        withdrawOrderId,
        // For Binance-to-Binance (internal) transfers the fee, if any, stays with the sender.
        transactionFeeFlag: false,
        walletType: 0, // spot wallet
      }),

    /** Total value of each wallet (Spot, Funding, Earn, Futures, ...) in `quoteAsset`. */
    walletBalances: (quoteAsset) => call('GET', '/sapi/v1/asset/wallet/balance', { quoteAsset }),

    fundingAssets: () => call('POST', '/sapi/v1/asset/get-funding-asset'),

    flexibleEarn: () => call('GET', '/sapi/v1/simple-earn/flexible/position', { size: 100 }),

    lockedEarn: () => call('GET', '/sapi/v1/simple-earn/locked/position', { size: 100 }),

    crossMargin: () => call('GET', '/sapi/v1/margin/account'),

    usdmFutures: () => call('GET', '/fapi/v2/balance', {}, config.binanceUsdmUrl),

    coinmFutures: () => call('GET', '/dapi/v1/balance', {}, config.binanceCoinmUrl),

    /** Move funds between the user's own wallets, e.g. type FUNDING_MAIN / UMFUTURE_MAIN / CMFUTURE_MAIN. */
    universalTransfer: (type, asset, amount) => call('POST', '/sapi/v1/asset/transfer', { type, asset, amount }),

    /**
     * Turn on Fast Withdraw: withdrawals to another Binance user's deposit address are then settled
     * internally (instant, no fee). Idempotent.
     */
    enableFastWithdraw: () => call('POST', '/sapi/v1/account/enableFastWithdrawSwitch'),

    // ---- Travel Rule (accounts under a local Binance entity, e.g. India, UAE) ----

    /** { questionnaireCountryCode } — which travel rule form this account must send with withdrawals. */
    questionnaireRequirements: () => call('GET', '/sapi/v1/localentity/questionnaire-requirements'),

    /** [{ vaspName, vaspCode, identifier }] — exchanges that can be named as the beneficiary's VASP. */
    vaspList: () => call('GET', '/sapi/v1/localentity/vasp'),

    /** Withdraw with a travel rule questionnaire. Returns { trId, accepted, info }. */
    travelRuleWithdraw: ({ coin, network, address, addressTag, amount, withdrawOrderId, questionnaire }) =>
      call('POST', '/sapi/v1/localentity/withdraw/apply', {
        coin,
        network,
        address,
        addressTag,
        amount,
        withdrawOrderId,
        questionnaire: JSON.stringify(questionnaire),
        transactionFeeFlag: false,
        walletType: 0,
      }),

    /** Redeem a Simple Earn Flexible position back to the spot wallet. */
    redeemFlexible: (productId, amount) =>
      call('POST', '/sapi/v1/simple-earn/flexible/redeem', { productId, amount, destAccount: 'SPOT' }),
  };
}

/** Find a coin's config entry (case-insensitive) from /capital/config/getall. */
export async function getCoinConfig(client, coin) {
  const coins = await client.allCoins();
  return coins.find((c) => c.coin.toUpperCase() === coin.toUpperCase()) ?? null;
}

export function friendlyError(err) {
  if (!(err instanceof BinanceError)) return 'Could not reach Binance. Please try again in a moment.';
  switch (err.code) {
    case -2014:
    case -2015:
    case -2008:
      return 'Binance rejected the API key (invalid key, wrong IP, or missing permission).';
    case -1022:
      return 'Binance rejected the API secret (invalid signature).';
    case -1021:
      return 'Clock sync error with Binance. Please try again.';
    case -4026:
      return 'Withdrawals are not enabled for this API key.';
    default:
      return `Binance: ${err.message}`;
  }
}
