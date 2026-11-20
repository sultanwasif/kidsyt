import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const file = process.env.DB_FILE || './data/kidsyt.db';
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS parents (
  id          INTEGER PRIMARY KEY,
  google_sub  TEXT UNIQUE NOT NULL,
  email       TEXT,
  name        TEXT,
  picture     TEXT,
  pin_hash    TEXT,
  settings    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,
  parent_id   INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_parent ON sessions(parent_id);
CREATE TABLE IF NOT EXISTS channels (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  thumb       TEXT,
  uploads     TEXT NOT NULL,
  videos      TEXT,
  fetched_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  thumb       TEXT,
  channel     TEXT,
  videos      TEXT,
  fetched_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS picks (
  id          TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage (
  parent_id   INTEGER NOT NULL REFERENCES parents(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0,
  bonus       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (parent_id, day)
);
`);

// Housekeeping: drop expired sessions and old usage rows once a day.
function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  const cutoff = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  db.prepare('DELETE FROM usage WHERE day < ?').run(cutoff);
}
cleanup();
setInterval(cleanup, 24 * 3600 * 1000).unref();
