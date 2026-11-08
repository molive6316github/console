import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, syncServers, listServers, getSetting, setSetting } from "../src/db.js";

// The schema exactly as v0.1 shipped it.
const OLD = `
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','operator','viewer')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, target TEXT NOT NULL);
  CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (datetime('now')), username TEXT NOT NULL,
    server_id TEXT, action TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT);
`;

test("an existing database upgrades in place and keeps its data", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-mig-"));
  const file = path.join(dir, "old.db");
  const old = new DatabaseSync(file);
  old.exec(OLD);
  old.prepare("INSERT INTO users (username, password_hash, role) VALUES ('max', 'x:y', 'admin')").run();
  old.prepare("INSERT INTO servers (id, name, type, target) VALUES ('mc', 'Minecraft', 'dummy', '{}')").run();
  old.prepare("INSERT INTO audit_log (username, action, ok) VALUES ('max', 'login', 1)").run();
  old.close();

  const db = openDb(file);
  const u = db.prepare("SELECT username, role, all_servers FROM users").get();
  assert.deepEqual({ ...u }, { username: "max", role: "admin", all_servers: 1 });
  assert.equal(listServers(db)[0].source, "file");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n, 1);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  db.close();

  const again = openDb(file); // opening twice must be a no-op
  assert.equal(again.prepare("PRAGMA user_version").get().user_version, 3);
});

test("servers.json only manages its own rows: UI-added servers survive a sync", () => {
  const db = openDb(":memory:");
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "console-sync-")), "servers.json");
  writeFileSync(cfg, JSON.stringify([{ id: "a", name: "A", type: "dummy" }, { id: "b", name: "B", type: "dummy" }]));
  syncServers(db, cfg);
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mine', 'Mine', 'dummy', '{}', 'ui')").run();

  writeFileSync(cfg, JSON.stringify([{ id: "a", name: "A2", type: "dummy" }]));
  syncServers(db, cfg);
  const rows = Object.fromEntries(listServers(db).map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(rows).sort(), ["a", "mine"]);
  assert.equal(rows.a.name, "A2");
  assert.equal(rows.mine.source, "ui");
});

test("removing a server from servers.json also removes its schedules and history", () => {
  const db = openDb(":memory:");
  const cfg = path.join(mkdtempSync(path.join(tmpdir(), "console-sync-")), "servers.json");
  writeFileSync(cfg, JSON.stringify([{ id: "a", name: "A", type: "dummy" }]));
  syncServers(db, cfg);
  db.prepare("INSERT INTO schedules (server_id, action, cron, created_by) VALUES ('a', 'restart', '0 4 * * *', 'x')").run();
  db.prepare("INSERT INTO checks (server_id, ts, up) VALUES ('a', 1, 1)").run();
  writeFileSync(cfg, "[]");
  syncServers(db, cfg);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get().n, 0);
});

test("settings round-trip and empty clears", () => {
  const db = openDb(":memory:");
  assert.equal(getSetting(db, "x", "dflt"), "dflt");
  setSetting(db, "x", "1");
  assert.equal(getSetting(db, "x"), "1");
  setSetting(db, "x", "");
  assert.equal(getSetting(db, "x"), null);
});
