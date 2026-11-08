import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";

test("Claude Code: needs the terminal on first, admin only, reports install state, audit trail", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cc-"));
  const dir = path.join(dataDir, "tools");
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)");
  ins.run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  ins.run("op", hashPassword("pw-operator-123"), "operator", Date.now());
  const run = async (cmd, args) => (args[0] === "--version" ? { code: 0, stdout: cmd.endsWith("claude") ? "2.0.1 (Claude Code)\n" : "10.0.0\n", stderr: "" } : { code: 0, stdout: "", stderr: "" });
  const app = buildApp({ db, services: createServices({ db, dataDir }), dataDir, claudeOptions: { dir, run } });
  const login = async (u, p) => { const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } }); return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`; };
  const boss = await login("boss", "pw-admin-123"), op = await login("op", "pw-operator-123");
  const call = (c, m, u, p) => app.inject({ method: m, url: u, headers: { cookie: c }, payload: p });

  assert.equal((await call(op, "GET", "/api/claude-code")).statusCode, 403);
  let s = (await call(boss, "GET", "/api/claude-code")).json();
  assert.deepEqual([s.enabled, s.installed, s.terminalEnabled], [false, false, false]);
  assert.equal((await call(boss, "PUT", "/api/claude-code", { enabled: true })).statusCode, 400, "terminal must be on first");
  assert.equal((await call(boss, "POST", "/api/claude-code/install", {})).statusCode, 400, "must be enabled first");

  setSetting(db, "terminal_enabled", "1");
  assert.equal((await call(boss, "PUT", "/api/claude-code", { enabled: true })).json().enabled, true);
  mkdirSync(path.join(dir, "node_modules", ".bin"), { recursive: true });
  writeFileSync(path.join(dir, "node_modules", ".bin", "claude"), "");
  s = (await call(boss, "GET", "/api/claude-code")).json();
  assert.deepEqual([s.installed, s.version], [true, "2.0.1"]);
  assert.equal((await call(boss, "DELETE", "/api/claude-code")).json().installed, false);
  const log = db.prepare("SELECT action FROM audit_log WHERE action LIKE 'claude_code%'").all().map((r) => r.action);
  assert.ok(log.includes("claude_code") && log.includes("claude_code_remove"));
});
