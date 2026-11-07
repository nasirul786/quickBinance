import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id   INTEGER PRIMARY KEY,
    username      TEXT,
    first_name    TEXT,
    binance_uid   TEXT UNIQUE,
    api_key_enc   TEXT,
    api_secret_enc TEXT,
    can_withdraw  INTEGER NOT NULL DEFAULT 0,
    started_bot   INTEGER NOT NULL DEFAULT 0,
    connected_at  INTEGER,
    updated_at    INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(lower(username));

  CREATE TABLE IF NOT EXISTS tips (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    from_tg        INTEGER NOT NULL,
    to_tg          INTEGER NOT NULL,
    coin           TEXT NOT NULL,
    network        TEXT,
    address        TEXT,
    address_tag    TEXT,
    amount         TEXT NOT NULL,   -- amount the sender typed
    fee            TEXT,
    fee_mode       TEXT,            -- deduct (recipient gets amount - fee) | extra (sender pays amount + fee) | none
    send_amount    TEXT,            -- amount actually passed to Binance withdraw
    note           TEXT,
    chat_id        INTEGER,
    message_id     INTEGER,
    status         TEXT NOT NULL DEFAULT 'pending', -- pending | processing | sent | failed | cancelled | expired
    withdraw_id    TEXT,
    error          TEXT,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_tips_from ON tips(from_tg, created_at);
  CREATE INDEX IF NOT EXISTS idx_tips_to ON tips(to_tg, created_at);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS withdrawals (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    telegram_id  INTEGER NOT NULL,
    coin         TEXT NOT NULL,
    address      TEXT NOT NULL,
    memo         TEXT,             -- memo the user typed (only sent on networks that support one)
    network      TEXT,
    amount       TEXT,             -- amount the user entered, or 'max'
    fee          TEXT,
    fee_mode     TEXT,             -- deduct | extra | none
    send_amount  TEXT,
    status       TEXT NOT NULL DEFAULT 'pending', -- pending | processing | sent | failed | cancelled | expired
    withdraw_id  TEXT,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_withdrawals_user ON withdrawals(telegram_id, created_at);
`);

// Columns added after the first release; add them to databases created before.
const tipColumns = new Set(db.prepare('PRAGMA table_info(tips)').all().map((c) => c.name));
for (const col of ['fee_mode', 'send_amount', 'travel_country']) {
  if (!tipColumns.has(col)) db.exec(`ALTER TABLE tips ADD COLUMN ${col} TEXT`);
}
// Travel Rule details a user shares so others can tip them from accounts that need the form.
const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
for (const col of ['legal_name', 'legal_country', 'legal_city']) {
  if (!userColumns.has(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}

// travel_country: travel rule form required for this account (e.g. IN), null if none
// questionnaire: JSON answers sent to Binance's travel rule withdraw API
const withdrawalColumns = new Set(db.prepare('PRAGMA table_info(withdrawals)').all().map((c) => c.name));
for (const col of ['travel_country', 'questionnaire']) {
  if (!withdrawalColumns.has(col)) db.exec(`ALTER TABLE withdrawals ADD COLUMN ${col} TEXT`);
}

const now = () => Date.now();

// ---------- users ----------

const upsertProfileStmt = db.prepare(`
  INSERT INTO users (telegram_id, username, first_name, updated_at)
  VALUES (@telegram_id, @username, @first_name, @updated_at)
  ON CONFLICT(telegram_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    updated_at = excluded.updated_at
`);

export function touchUser(from) {
  if (!from || from.is_bot) return;
  upsertProfileStmt.run({
    telegram_id: from.id,
    username: from.username ?? null,
    first_name: from.first_name ?? null,
    updated_at: now(),
  });
}

export function markStartedBot(telegramId) {
  db.prepare('UPDATE users SET started_bot = 1, updated_at = ? WHERE telegram_id = ?').run(now(), telegramId);
}

export function getUser(telegramId) {
  return db.prepare('SELECT * FROM users WHERE telegram_id = ?').get(telegramId) ?? null;
}

export function getUserByBinanceUid(uid) {
  return db.prepare('SELECT * FROM users WHERE binance_uid = ?').get(String(uid)) ?? null;
}

export function getUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE lower(username) = lower(?)').get(username.replace(/^@/, '')) ?? null;
}

export function isConnected(user) {
  return Boolean(user && user.api_key_enc && user.api_secret_enc);
}

export function getCredentials(user) {
  return { apiKey: decrypt(user.api_key_enc), apiSecret: decrypt(user.api_secret_enc) };
}

export function saveConnection(telegramId, { apiKey, apiSecret, uid, canWithdraw }) {
  const tx = db.transaction(() => {
    // A Binance account can only be linked to one Telegram user at a time.
    db.prepare(`
      UPDATE users SET binance_uid = NULL, api_key_enc = NULL, api_secret_enc = NULL,
        can_withdraw = 0, connected_at = NULL, updated_at = ?
      WHERE binance_uid = ? AND telegram_id != ?
    `).run(now(), String(uid), telegramId);

    db.prepare(`
      UPDATE users SET binance_uid = ?, api_key_enc = ?, api_secret_enc = ?,
        can_withdraw = ?, connected_at = ?, updated_at = ?
      WHERE telegram_id = ?
    `).run(String(uid), encrypt(apiKey), encrypt(apiSecret), canWithdraw ? 1 : 0, now(), now(), telegramId);
  });
  tx();
}

export function setCanWithdraw(telegramId, canWithdraw) {
  db.prepare('UPDATE users SET can_withdraw = ?, updated_at = ? WHERE telegram_id = ?').run(canWithdraw ? 1 : 0, now(), telegramId);
}

export function setTravelInfo(telegramId, { name, country, city }) {
  db.prepare('UPDATE users SET legal_name = ?, legal_country = ?, legal_city = ?, updated_at = ? WHERE telegram_id = ?').run(
    name ?? null,
    country ?? null,
    city ?? null,
    now(),
    telegramId,
  );
}

export function removeConnection(telegramId) {
  db.prepare(`
    UPDATE users SET binance_uid = NULL, api_key_enc = NULL, api_secret_enc = NULL,
      can_withdraw = 0, connected_at = NULL, updated_at = ?
    WHERE telegram_id = ?
  `).run(now(), telegramId);
}

// ---------- tips ----------

export function createTip(tip) {
  const info = db.prepare(`
    INSERT INTO tips (from_tg, to_tg, coin, network, address, address_tag, amount, fee, note, chat_id, status, created_at, updated_at)
    VALUES (@from_tg, @to_tg, @coin, @network, @address, @address_tag, @amount, @fee, @note, @chat_id, 'pending', @created_at, @created_at)
  `).run({ ...tip, created_at: now() });
  return Number(info.lastInsertRowid);
}

export function getTip(id) {
  return db.prepare('SELECT * FROM tips WHERE id = ?').get(id) ?? null;
}

const TIP_EDITABLE = ['network', 'address', 'address_tag', 'fee', 'fee_mode', 'send_amount', 'travel_country'];

/** Update choices on a tip that is still pending. */
export function updatePendingTip(id, fields) {
  const keys = Object.keys(fields).filter((k) => TIP_EDITABLE.includes(k));
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE tips SET ${sets}, updated_at = @now WHERE id = @id AND status = 'pending'`).run({
    ...Object.fromEntries(keys.map((k) => [k, fields[k] ?? null])),
    now: now(),
    id,
  });
}

export function setTipMessage(id, messageId) {
  db.prepare('UPDATE tips SET message_id = ?, updated_at = ? WHERE id = ?').run(messageId, now(), id);
}

/** Atomically move a tip from one status to another. Returns true if this caller won the transition. */
export function transitionTip(id, fromStatus, toStatus, extra = {}) {
  const info = db.prepare(`
    UPDATE tips SET status = @to, withdraw_id = COALESCE(@withdraw_id, withdraw_id),
      error = COALESCE(@error, error), updated_at = @now
    WHERE id = @id AND status = @from
  `).run({
    id,
    from: fromStatus,
    to: toStatus,
    withdraw_id: extra.withdrawId ?? null,
    error: extra.error ?? null,
    now: now(),
  });
  return info.changes === 1;
}

export function listTipsForUser(telegramId, limit = 10) {
  return db.prepare(`
    SELECT * FROM tips
    WHERE (from_tg = ? OR to_tg = ?) AND status IN ('sent', 'failed')
    ORDER BY created_at DESC LIMIT ?
  `).all(telegramId, telegramId, limit);
}

// ---------- withdrawals ----------

export function createWithdrawal(w) {
  const info = db.prepare(`
    INSERT INTO withdrawals (telegram_id, coin, address, memo, amount, status, created_at, updated_at)
    VALUES (@telegram_id, @coin, @address, @memo, @amount, 'pending', @created_at, @created_at)
  `).run({ ...w, created_at: now() });
  return Number(info.lastInsertRowid);
}

export function getWithdrawal(id) {
  return db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id) ?? null;
}

const WITHDRAWAL_EDITABLE = ['network', 'fee', 'fee_mode', 'send_amount', 'travel_country', 'questionnaire'];

export function updatePendingWithdrawal(id, fields) {
  const keys = Object.keys(fields).filter((k) => WITHDRAWAL_EDITABLE.includes(k));
  const sets = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE withdrawals SET ${sets}, updated_at = @now WHERE id = @id AND status = 'pending'`).run({
    ...Object.fromEntries(keys.map((k) => [k, fields[k] ?? null])),
    now: now(),
    id,
  });
}

export function listWithdrawalsForUser(telegramId, limit = 10) {
  return db.prepare(`
    SELECT * FROM withdrawals
    WHERE telegram_id = ? AND status IN ('sent', 'failed')
    ORDER BY created_at DESC LIMIT ?
  `).all(telegramId, limit);
}

export function transitionWithdrawal(id, fromStatus, toStatus, extra = {}) {
  const info = db.prepare(`
    UPDATE withdrawals SET status = @to, withdraw_id = COALESCE(@withdraw_id, withdraw_id),
      error = COALESCE(@error, error), updated_at = @now
    WHERE id = @id AND status = @from
  `).run({
    id,
    from: fromStatus,
    to: toStatus,
    withdraw_id: extra.withdrawId ?? null,
    error: extra.error ?? null,
    now: now(),
  });
  return info.changes === 1;
}

export default db;
