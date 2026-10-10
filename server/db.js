'use strict';
// db.js - SQLite connection holder, schema, migrations, shared helpers
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const APP_DIR = path.resolve(__dirname, '..');
// Persistent application-data folder (never a temp dir). Overridable for packaged apps.
const DATA_DIR = process.env.MPDO_DATA_DIR || path.join(APP_DIR, 'data');
const DB_PATH = path.join(DATA_DIR, 'mpdo_cemetery.db');

const BURIAL_TYPES = [
  'Apartment 1st Floor',
  'Apartment 2nd Floor',
  'Apartment 3rd Floor',
  'Lot/Raised Vault',
  'Ground/Buried Vault',
  'Museleo',
];

const PAYMENT_METHODS = ['Installment', 'Full Payment (Cash)', 'N/A'];

const DEFAULT_PRICING = {
  'Apartment 1st Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Apartment 2nd Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Apartment 3rd Floor': { Installment: 2500000, 'Full Payment (Cash)': 2000000 },
  'Lot/Raised Vault': { Installment: 3000000, 'Full Payment (Cash)': 2000000 },
  'Ground/Buried Vault': { Installment: 3000000, 'Full Payment (Cash)': 2000000 },
  'Museleo': { Installment: 7000000, 'Full Payment (Cash)': 6000000 },
};

let db = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS LoginDb (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('Administrator','Staff','Viewer')),
  account_status TEXT NOT NULL DEFAULT 'Active' CHECK (account_status IN ('Active','Inactive')),
  date_created TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS MainDb (
  record_id INTEGER PRIMARY KEY AUTOINCREMENT,
  control_number TEXT NOT NULL UNIQUE,
  deceased_name TEXT NOT NULL,
  date_of_death TEXT,
  date_of_burial TEXT,
  burial_type TEXT NOT NULL CHECK (burial_type IN (${BURIAL_TYPES.map(t => `'${t}'`).join(',')})),
  indigent TEXT NOT NULL CHECK (indigent IN ('Yes','No')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('Installment','Full Payment (Cash)','N/A')),
  total_cents INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS PaymentDb (
  payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_ref TEXT UNIQUE,
  record_id INTEGER NOT NULL REFERENCES MainDb(record_id) ON DELETE RESTRICT,
  control_number TEXT NOT NULL REFERENCES MainDb(control_number) ON DELETE RESTRICT,
  date_process TEXT NOT NULL,
  relative_name TEXT NOT NULL,
  relative_address TEXT,
  contact_number TEXT,
  deceased_relation TEXT,
  relative_relation TEXT,
  age INTEGER,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  cedula_number TEXT,
  cedula_date TEXT,
  cedula_place TEXT,
  or_number TEXT,
  or_date TEXT,
  or_place TEXT,
  remarks TEXT,
  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_cn ON PaymentDb(control_number);

CREATE TABLE IF NOT EXISTS SequenceDb (
  year INTEGER PRIMARY KEY,
  last_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS SessionDb (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES LoginDb(user_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS AuditDb (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  details TEXT,
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS SettingsDb (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function getDb() {
  if (!db) throw new Error('Database not opened');
  return db;
}

function openDb(dbPath) {
  const p = dbPath || DB_PATH;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  db = new Database(p);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Migration: add Age column to PaymentDb on databases created before it existed
  const payCols = db.pragma('table_info(PaymentDb)');
  if (!payCols.some(c => c.name === 'age')) db.exec('ALTER TABLE PaymentDb ADD COLUMN age INTEGER');
  migratePaymentAmountCheck(db);
  if (!getSettingSync('pricing')) setSettingSync('pricing', JSON.stringify(DEFAULT_PRICING));
  return db;
}

function closeDb() {
  if (db) {
    try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { /* ignore */ }
    db.close();
    db = null;
  }
}

function getSettingSync(key) {
  const row = db.prepare('SELECT value FROM SettingsDb WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSettingSync(key, value) {
  db.prepare('INSERT INTO SettingsDb (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

function getPricing() {
  try {
    const raw = getSettingSync('pricing');
    if (raw) {
      const parsed = JSON.parse(raw);
      // validate shape; fall back per-missing-key to defaults
      return { ...DEFAULT_PRICING, ...parsed };
    }
  } catch (e) { /* ignore */ }
  return { ...DEFAULT_PRICING };
}

// Indigent payment records store Amount Paid = 0.00, so the legacy CHECK (amount_cents > 0)
// must be relaxed to >= 0. SQLite cannot alter constraints, so rebuild the table transactionally.
function migratePaymentAmountCheck(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='PaymentDb'").get();
  if (!row || !/amount_cents\s*>\s*0/.test(row.sql || '')) return; // already relaxed
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`BEGIN;
      CREATE TABLE PaymentDb_new (
        payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_ref TEXT UNIQUE,
        record_id INTEGER NOT NULL REFERENCES MainDb(record_id) ON DELETE RESTRICT,
        control_number TEXT NOT NULL REFERENCES MainDb(control_number) ON DELETE RESTRICT,
        date_process TEXT NOT NULL,
        relative_name TEXT NOT NULL,
        relative_address TEXT,
        contact_number TEXT,
        deceased_relation TEXT,
        relative_relation TEXT,
        age INTEGER,
        amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
        cedula_number TEXT,
        cedula_date TEXT,
        cedula_place TEXT,
        or_number TEXT,
        or_date TEXT,
        or_place TEXT,
        remarks TEXT,
        created_by TEXT,
        updated_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT
      );
      INSERT INTO PaymentDb_new (payment_id, client_ref, record_id, control_number, date_process, relative_name,
        relative_address, contact_number, deceased_relation, relative_relation, age, amount_cents,
        cedula_number, cedula_date, cedula_place, or_number, or_date, or_place, remarks,
        created_by, updated_by, created_at, updated_at)
      SELECT payment_id, client_ref, record_id, control_number, date_process, relative_name,
        relative_address, contact_number, deceased_relation, relative_relation, age, amount_cents,
        cedula_number, cedula_date, cedula_place, or_number, or_date, or_place, remarks,
        created_by, updated_by, created_at, updated_at FROM PaymentDb;
      DROP TABLE PaymentDb;
      ALTER TABLE PaymentDb_new RENAME TO PaymentDb;
      CREATE INDEX idx_payments_cn ON PaymentDb(control_number);
      COMMIT;`);
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
    throw e;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function nowIso() { return new Date().toISOString(); }

function todayStr() { return new Date().toISOString().slice(0, 10); }

module.exports = {
  APP_DIR, DATA_DIR, DB_PATH, BURIAL_TYPES, PAYMENT_METHODS, DEFAULT_PRICING,
  getDb, openDb, closeDb, getSettingSync, setSettingSync, getPricing, nowIso, todayStr,
};
