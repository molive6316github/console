import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { driverTypes } from "./drivers/index.js";

export function openDb(file) {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')),
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS servers (
      id     TEXT PRIMARY KEY,
      name   TEXT NOT NULL,
      type   TEXT NOT NULL,
      target TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL DEFAULT (datetime('now')),
      username  TEXT NOT NULL,
      server_id TEXT,
      action    TEXT NOT NULL,
      ok        INTEGER NOT NULL,
      detail    TEXT
    );
  `);
  migrate(db);
  return db;
}

// Versioned, in-place upgrades (PRAGMA user_version). Existing installs keep their users, servers and audit log.
// Add new steps to the END of the list, never edit an old one.
const MIGRATIONS = [
  // 1: UI-managed servers, per-user server scope
  `ALTER TABLE servers ADD COLUMN source TEXT NOT NULL DEFAULT 'file';
   ALTER TABLE users ADD COLUMN all_servers INTEGER NOT NULL DEFAULT 1;
   CREATE TABLE user_servers (
     user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     server_id TEXT    NOT NULL,
     PRIMARY KEY (user_id, server_id)
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  // 2: monitoring, metrics, schedules
  `CREATE TABLE server_state (
     server_id TEXT PRIMARY KEY,
     status    TEXT,
     since     INTEGER,
     expected  TEXT,
     fails     INTEGER NOT NULL DEFAULT 0,
     alerted   INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE checks (
     server_id TEXT NOT NULL,
     ts        INTEGER NOT NULL,
     up        INTEGER
   );
   CREATE INDEX checks_idx ON checks (server_id, ts);
   CREATE TABLE host_metrics (
     ts         INTEGER PRIMARY KEY,
     cpu        REAL,
     mem_used   INTEGER,
     mem_total  INTEGER,
     disk_used  INTEGER,
     disk_total INTEGER,
     load1      REAL
   );
   CREATE TABLE schedules (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     server_id   TEXT NOT NULL,
     action      TEXT NOT NULL,
     arg         TEXT,
     cron        TEXT NOT NULL,
     enabled     INTEGER NOT NULL DEFAULT 1,
     created_by  TEXT NOT NULL,
     last_minute INTEGER,
     last_status TEXT,
     last_detail TEXT
   );`,
];

function migrate(db) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Database upgrade ${v + 1} failed: ${e.message}`);
    }
  }
}

export const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

// servers.json is the source of truth: rows are synced to it on every start.
export function syncServers(db, configPath) {
  if (!existsSync(configPath)) return { synced: 0, missing: true };
  const list = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(list)) throw new Error("servers.json must be an array");

  const seen = new Set();
  const upsert = db.prepare(
    `INSERT INTO servers (id, name, type, target, source) VALUES (?, ?, ?, ?, 'file')
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, target = excluded.target, source = 'file'`
  );
  for (const s of list) {
    if (!ID.test(s.id ?? "")) throw new Error(`Bad server id: ${JSON.stringify(s.id)} (use a-z, 0-9, dashes)`);
    if (seen.has(s.id)) throw new Error(`Duplicate server id: ${s.id}`);
    if (!driverTypes.includes(s.type)) throw new Error(`Server ${s.id}: unknown type "${s.type}"`);
    seen.add(s.id);
    upsert.run(s.id, String(s.name ?? s.id), s.type, JSON.stringify(s.target ?? {}));
  }
  // Only file-managed rows are removed when they leave servers.json. Servers added in the UI are left alone.
  const existing = db.prepare("SELECT id FROM servers WHERE source = 'file'").all();
  for (const row of existing) if (!seen.has(row.id)) deleteServer(db, row.id);
  return { synced: list.length, missing: false };
}

// Removes a server and everything that hangs off it.
export function deleteServer(db, id) {
  for (const t of ["server_state", "checks", "schedules", "user_servers"]) {
    db.prepare(`DELETE FROM ${t} WHERE server_id = ?`).run(id);
  }
  db.prepare("DELETE FROM servers WHERE id = ?").run(id);
}

export function listServers(db) {
  return db
    .prepare("SELECT id, name, type, target, source FROM servers ORDER BY name COLLATE NOCASE")
    .all()
    .map((r) => ({ ...r, target: JSON.parse(r.target) }));
}

export function getServer(db, id) {
  const r = db.prepare("SELECT id, name, type, target, source FROM servers WHERE id = ?").get(id);
  return r ? { ...r, target: JSON.parse(r.target) } : null;
}

export function getSetting(db, key, fallback = null) {
  const r = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return r ? r.value : fallback;
}

export function setSetting(db, key, value) {
  if (value === null || value === "") db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

export function audit(db, { username, serverId = null, action, ok, detail = null }) {
  db.prepare("INSERT INTO audit_log (username, server_id, action, ok, detail) VALUES (?, ?, ?, ?, ?)").run(
    username,
    serverId,
    action,
    ok ? 1 : 0,
    detail ? String(detail).slice(0, 500) : null
  );
}
