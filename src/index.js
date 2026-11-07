import { Bot, GrammyError, HttpError } from 'grammy';
import { config } from './config.js';
import * as db from './db.js';
import { describeProxy } from './proxy.js';
import account from './handlers/account.js';
import deposit from './handlers/deposit.js';
import tip from './handlers/tip.js';
import withdraw from './handlers/withdraw.js';
import travelinfo from './handlers/travelinfo.js';

// Telegram connects directly; only Binance requests use the proxy (see proxy.js).
const bot = new Bot(config.botToken);

// Remember everyone we see so replies / @usernames can be resolved to users.
bot.use(async (ctx, next) => {
  db.touchUser(ctx.from);
  await next();
});

// Flows that wait for typed answers go first; each passes other messages on.
bot.use(withdraw);
bot.use(travelinfo);
bot.use(account);
bot.use(deposit);
bot.use(tip);

bot.catch((err) => {
  const e = err.error;
  if (e instanceof GrammyError) console.error('Telegram error:', e.description);
  else if (e instanceof HttpError) console.error('Could not contact Telegram:', e);
  else console.error('Unhandled error:', e);
});

await bot.api.setMyCommands([
  { command: 'bn', description: 'Tip: /bn <amount> <token> [binance id] <note>' },
  { command: 'binance', description: 'Same as /bn' },
  { command: 'deposit', description: 'Get a deposit address: /deposit usdt' },
  { command: 'withdraw', description: 'Withdraw: /withdraw <amount> <token> <address> [memo]' },
  { command: 'connect', description: 'Connect your Binance account' },
  { command: 'balance', description: 'Show your Binance balances' },
  { command: 'myid', description: 'Show your Binance ID' },
  { command: 'ip', description: 'IP to whitelist on your Binance API key' },
  { command: 'travelinfo', description: 'Travel Rule details so others can tip you' },
  { command: 'history', description: 'Your recent tips and withdrawals' },
  { command: 'disconnect', description: 'Disconnect your Binance account' },
  { command: 'help', description: 'How to use Quick Binance' },
]);

const stop = () => bot.stop();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

console.log(`Quick Binance is starting… (Binance proxy: ${describeProxy()})`);
await bot.start({
  onStart: (me) => console.log(`Quick Binance running as @${me.username}`),
});
