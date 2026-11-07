# Quick Binance

A Telegram bot for tipping, sending and receiving crypto between Binance accounts, right inside Telegram chats.

Users link their own Binance account with an API key. They can then:
- tip someone by replying to their message
- withdraw to any address
- get deposit addresses
- check every wallet

Built with [grammY](https://grammy.dev), Node.js and SQLite.

```
/bn 10 usdt Take a gift from me      ← reply to someone's message
```

> **Not affiliated with Binance.** This is an independent open-source project. Whoever runs the bot holds its users' API keys, including keys that can withdraw funds. Only run it, or use someone's instance, if you understand and accept that.

---

## Features

- **Tips in any chat.** Reply to a message with `/bn 10 usdt Thanks!`, or tip by Binance ID. Only the sender can confirm, and each tip expires if it isn't confirmed.
- **Free, instant tips.** The bot turns on Binance's *Fast Withdraw Switch* for the sender. Binance then settles payments to another Binance user's deposit address internally, with no fee.
- **Withdrawals** to any address. The bot detects the network from the address (🟢), supports memos/tags, and accepts `max` as the amount.
- **Network fee options.** On on-chain transfers you choose whether the fee is deducted from the amount or paid on top.
- **Uses all your wallets.** Spot first, then Funding, Flexible Earn and Futures. For example, a 60 USDT tip with 40 in Spot and 50 in Earn takes Spot 40 + Earn 20.
- **Deposit addresses.** `/deposit usdt` shows a button per network, and the address with its memo when one is needed.
- **Balances** of every wallet with an estimated total. In groups the numbers sit behind a spoiler.
- **Travel Rule support** for accounts under a local Binance entity (India, UAE). The bot asks the required questions in chat.
- **History** of tips and withdrawals in one list.
- **Coloured buttons** (Telegram Bot API 9.4 button styles): green confirms, red cancels, blue for the main choices.
- **Safety:** API keys are encrypted at rest (AES-256-GCM), key messages are deleted right after reading, and withdraw permission is checked live with Binance. A tip or withdrawal can't be sent twice.
- **Optional proxy** (SOCKS5 or HTTP) for Binance requests.

## Commands

| Command | Where | What it does |
| --- | --- | --- |
| `/start`, `/help` | anywhere | Welcome message and help |
| `/connect` | private | Link a Binance account. The bot asks for the API key and secret, deleting each message after reading it |
| `/disconnect` | anywhere | Unlink and delete the stored keys (asks for confirmation) |
| `/balance` | anywhere | Value of each wallet and the coins in it. Hidden behind a spoiler in groups |
| `/myid` | anywhere | Show your Binance ID so others can tip you |
| `/ip` | anywhere | The IP to whitelist on your API key: the server's, or the proxy's when `USE_PROXY=1`. Includes a copy button |
| `/deposit <token>` | anywhere | Choose a network to get your deposit address |
| `/bn <amount> <token> <note>` | reply | Tip the author of the message you reply to |
| `/bn <amount> <token> <binance id> <note>` | anywhere | Tip by Binance ID (or `@username` of a connected user) |
| `/binance`, `/tip`, `/send` | | Same as `/bn` |
| `/withdraw <amount> <token> <address> [memo]` | private | Withdraw to any address. `max` sends everything |
| `/travelinfo` | private | Save your legal name and country so Travel Rule accounts can tip you |
| `/history` | anywhere | Recent tips and withdrawals |

If the person you tip hasn't connected Binance, the bot says so and nothing is sent.

## How it works

Binance has no public API for paying a Binance ID from a personal account. Quick Binance does this instead:

1. It looks up the recipient and fetches their deposit address with **their** key. Read-only is enough for this.
2. It turns on the sender's Fast Withdraw Switch (`POST /sapi/v1/account/enableFastWithdrawSwitch`).
3. It withdraws from the sender's Spot wallet to that address (`POST /sapi/v1/capital/withdraw/apply`). Binance recognises the address as one of its own users and settles the transfer internally, so it is instant and free.

If the Fast Withdraw Switch can't be turned on, the tip falls back to a normal on-chain withdrawal. You then pick the network and how to pay its fee.

**Funding from all wallets.** If Spot doesn't hold enough, the shortfall is moved into Spot first:
- Funding and Futures through universal transfer
- Flexible Earn through redemption

Wallets the API key isn't allowed to move money from are left out of the total, and the bot tells you which permission to enable. Locked Earn and Margin are never used.

## Binance API key permissions

Create the key in Binance → **API Management** → *Create API* → *System generated*.

| Permission | Needed for |
| --- | --- |
| Enable Reading | Everything (receiving tips, `/deposit`, `/balance`) |
| Enable Withdrawals + **Restrict access to trusted IPs only** | Sending tips and `/withdraw`. Binance blocks API withdrawals on unrestricted keys. Whitelist the bot server's IP, or the proxy's IP if `USE_PROXY=1`; `/ip` shows the IP to add, with a copy button. |
| Permits Universal Transfer | Using Funding and Futures balances |
| Enable Spot & Margin Trading | Using Flexible Earn balances and the Fast Withdraw Switch. The bot never places trades. |

Leave *Enable Futures* and the margin loan permissions **off**. The bot doesn't need them.

Permissions are checked live, so after changing them in Binance there is no need to `/connect` again.

## Travel Rule

Accounts registered under a local Binance entity must send a questionnaire with each withdrawal. The bot finds out whether an account needs one with `GET /sapi/v1/localentity/questionnaire-requirements`.

**`/withdraw`** asks the questions in chat:
- who owns the address
- whether the owner is a person or a company, and their name and country
- whether the address is a private wallet or an exchange

Exchanges are matched against Binance's VASP list, and unlisted ones are sent by name. The withdrawal then goes through `POST /sapi/v1/localentity/withdraw/apply`.

**Tips** send the recipient as the beneficiary, with Binance as the exchange. The recipient's details come from `/travelinfo`. If the recipient hasn't saved them, the bot asks them to.

Supported forms: **IN** (India) and **AE** (UAE). For any other entity, the bot shows its code and asks the user to withdraw in the Binance app. Contributions for more forms are welcome.

## Setup

Requirements: Node.js 18.17 or newer, and a bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/<you>/quickBinance.git
cd quickBinance
npm install
cp .env.example .env
npm run genkey      # copy the output into ENCRYPTION_KEY in .env
```

Put your bot token in `BOT_TOKEN`, then start the bot:

```bash
npm start           # or: npm run dev  (restarts on file changes)
```

The bot sets its own command menu on start. To use it in groups, just add it to the group. Commands work with privacy mode on.

## Configuration

All settings live in `.env`. See [`.env.example`](.env.example).

| Variable | Default | Description |
| --- | --- | --- |
| `BOT_TOKEN` | required | Telegram bot token |
| `ENCRYPTION_KEY` | required | 64 hex characters (`npm run genkey`). Encrypts stored API keys. **Back it up and never change it**: losing it makes every stored key unreadable. |
| `DB_PATH` | `./data/quickbinance.db` | SQLite database file |
| `TIP_CONFIRM_TTL_MINUTES` | `5` | How long a tip or withdrawal waits for confirmation |
| `BINANCE_BASE_URL` | `https://api.binance.com` | Binance Spot/SAPI endpoint |
| `BINANCE_USDM_URL` | `https://fapi.binance.com` | USDⓈ-M Futures endpoint |
| `BINANCE_COINM_URL` | `https://dapi.binance.com` | COIN-M Futures endpoint |
| `USE_PROXY` | `0` | `1` sends Binance requests through a proxy. Telegram always connects directly. |
| `PROXY_TYPE` | `socks5` | `socks5` or `http` |
| `PROXY_HOST`, `PROXY_PORT`, `PROXY_USERNAME`, `PROXY_PASSWORD` | | Proxy details |

Binance refuses requests from some regions, including the US. If you use a proxy, pick one in a supported country.

## Security

- **API keys** are encrypted with AES-256-GCM before they are stored. The messages containing them are deleted as soon as the bot reads them.
- **Server files:** keep `.env` and the `data/` folder private. Both are git-ignored.
- **Account links:** one Binance account can be linked to only one Telegram user.
- **Confirmation:** every tip and withdrawal needs an explicit confirmation from its sender. It is claimed atomically in the database, so a double tap can't send it twice.
- **Data shared with Binance:** Travel Rule details saved with `/travelinfo` are sent only to Binance, with tips to that user, and never shown in chats.

If you find a security issue, please open a private security advisory on GitHub instead of a public issue.

## Project layout

```
src/
  index.js            bot setup, middleware order, command menu
  config.js           environment config
  db.js               SQLite schema, migrations and queries
  crypto.js           AES-256-GCM encryption for API keys
  binance.js          signed Binance REST client
  proxy.js            optional SOCKS5/HTTP proxy for Binance requests
  decimal.js          exact decimal maths for amounts
  wallets.js          per-wallet balances for /balance
  funding.js          gathering funds from all wallets into Spot
  transfer.js         shared transfer logic: networks, fees, permissions, Travel Rule
  utils.js            HTML escaping, mentions, argument parsing
  handlers/
    account.js        /start /help /connect /disconnect /balance /myid
    deposit.js        /deposit
    tip.js            /bn and its aliases, /history
    withdraw.js       /withdraw, including the Travel Rule questions
    travelinfo.js     /travelinfo
```

## Contributing

Issues and pull requests are welcome. Please test changes against a Binance account with small amounts first. Real money moves.

## License

[MIT](LICENSE)
