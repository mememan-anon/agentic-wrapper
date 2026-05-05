import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

const databasePath = process.env.SQLITE_PATH || path.join(process.cwd(), "data", "app.sqlite");
const databaseDirectory = path.dirname(databasePath);

fs.mkdirSync(databaseDirectory, { recursive: true });

export const db = new Database(databasePath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS prepaid_balances (
    address TEXT PRIMARY KEY,
    balance_usd REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS prepaid_reservations (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS top_up_settlements (
    settlement_key TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_usd REAL NOT NULL,
    transaction_hash TEXT,
    network TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS siwx_nonces (
    nonce TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL,
    used_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_prep_reservations_address ON prepaid_reservations(address);
  CREATE INDEX IF NOT EXISTS idx_siwx_nonces_expires_at ON siwx_nonces(expires_at);
`);
