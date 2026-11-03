/**
 * SQLite 存储层（使用 Node 内置 node:sqlite，无第三方依赖）
 *
 * 要求 Node >= 22.5（22.x 需要 --experimental-sqlite 开关），
 * Node 23.4+ / 24 LTS 直接可用。
 */
const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')

let db = null

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  openid           TEXT PRIMARY KEY,
  active_family_id TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS families (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  owner_openid     TEXT NOT NULL,
  invite_code      TEXT NOT NULL UNIQUE,
  tz_offset_min    INTEGER NOT NULL DEFAULT 480,
  night_start_hour INTEGER NOT NULL DEFAULT 19,
  night_end_hour   INTEGER NOT NULL DEFAULT 7,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  schema_version   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS family_members (
  family_id  TEXT NOT NULL,
  openid     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, openid)
);
CREATE INDEX IF NOT EXISTS idx_members_openid ON family_members(openid);

CREATE TABLE IF NOT EXISTS records (
  id             TEXT PRIMARY KEY,
  family_id      TEXT NOT NULL,
  type           TEXT NOT NULL,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER,
  feed_kind      TEXT,
  side           TEXT,
  amount_ml      INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  deleted        INTEGER NOT NULL DEFAULT 0,
  deleted_at     INTEGER,
  created_by     TEXT NOT NULL,
  updated_by     TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_records_family_updated ON records(family_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_records_family_start   ON records(family_id, start_at);
CREATE INDEX IF NOT EXISTS idx_records_active         ON records(family_id, type, end_at);

CREATE TABLE IF NOT EXISTS backups (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  family_id    TEXT NOT NULL,
  day          TEXT NOT NULL,
  target       TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_backups_created ON backups(created_at);
`

function init(file) {
  const target = file || ':memory:'
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true })
  }
  db = new DatabaseSync(target)
  try {
    if (target !== ':memory:') db.exec('PRAGMA journal_mode = WAL')
  } catch (e) {
    // 某些文件系统不支持 WAL，退回默认日志模式即可
  }
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(SCHEMA)
  return db
}

function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 db.init()')
  return db
}

function get(sql, ...args) {
  return getDb().prepare(sql).get(...args) || null
}

function all(sql, ...args) {
  return getDb().prepare(sql).all(...args)
}

function run(sql, ...args) {
  const r = getDb().prepare(sql).run(...args)
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
}

function close() {
  if (db) {
    db.close()
    db = null
  }
}

module.exports = { init, get, all, run, close, getDb, SCHEMA }
