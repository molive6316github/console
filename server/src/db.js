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
  return db;
}

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

// servers.json is the source of truth: rows are synced to it on every start.
export function syncServers(db, configPath) {
  if (!existsSync(configPath)) return { synced: 0, missing: true };
  const list = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(list)) throw new Error("servers.json must be an array");

  const seen = new Set();
  const upsert = db.prepare(
    `INSERT INTO servers (id, name, type, target) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, type = excluded.type, target = excluded.target`
  );
  for (const s of list) {
    if (!ID.test(s.id ?? "")) throw new Error(`Bad server id: ${JSON.stringify(s.id)} (use a-z, 0-9, dashes)`);
    if (seen.has(s.id)) throw new Error(`Duplicate server id: ${s.id}`);
    if (!driverTypes.includes(s.type)) throw new Error(`Server ${s.id}: unknown type "${s.type}"`);
    seen.add(s.id);
    upsert.run(s.id, String(s.name ?? s.id), s.type, JSON.stringify(s.target ?? {}));
  }
  const existing = db.prepare("SELECT id FROM servers").all();
  const del = db.prepare("DELETE FROM servers WHERE id = ?");
  for (const row of existing) if (!seen.has(row.id)) del.run(row.id);
  return { synced: list.length, missing: false };
}

export function listServers(db) {
  return db
    .prepare("SELECT id, name, type, target FROM servers ORDER BY name COLLATE NOCASE")
    .all()
    .map((r) => ({ ...r, target: JSON.parse(r.target) }));
}

export function getServer(db, id) {
  const r = db.prepare("SELECT id, name, type, target FROM servers WHERE id = ?").get(id);
  return r ? { ...r, target: JSON.parse(r.target) } : null;
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
