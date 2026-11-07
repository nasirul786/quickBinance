import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name} (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const encryptionKey = required('ENCRYPTION_KEY');
if (!/^[0-9a-fA-F]{64}$/.test(encryptionKey)) {
  console.error('ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: npm run genkey');
  process.exit(1);
}

function proxyConfig() {
  if (process.env.USE_PROXY !== '1') return null;

  const type = (process.env.PROXY_TYPE || 'socks5').toLowerCase();
  if (!['socks5', 'http'].includes(type)) {
    console.error('PROXY_TYPE must be "socks5" or "http"');
    process.exit(1);
  }
  return {
    type,
    host: required('PROXY_HOST'),
    port: Number(required('PROXY_PORT')),
    username: process.env.PROXY_USERNAME || '',
    password: process.env.PROXY_PASSWORD || '',
  };
}

export const config = {
  proxy: proxyConfig(),
  botToken: required('BOT_TOKEN'),
  encryptionKey: Buffer.from(encryptionKey, 'hex'),
  dbPath: process.env.DB_PATH || './data/quickbinance.db',
  binanceBaseUrl: (process.env.BINANCE_BASE_URL || 'https://api.binance.com').replace(/\/+$/, ''),
  binanceUsdmUrl: (process.env.BINANCE_USDM_URL || 'https://fapi.binance.com').replace(/\/+$/, ''),
  binanceCoinmUrl: (process.env.BINANCE_COINM_URL || 'https://dapi.binance.com').replace(/\/+$/, ''),
  tipConfirmTtlMs: Number(process.env.TIP_CONFIRM_TTL_MINUTES || 5) * 60 * 1000,
};
