import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { PRESETS } from "../src/perms.js";

const until = async (fn, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 60)); } return null; };

async function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "console-asst-"));
  const dir = path.join(base, "srv"); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=Hi\nserver-port=25598\n");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers, perms) VALUES ('helper', ?, 'viewer', 0, ?)").run(hashPassword("pw-helper-123"), JSON.stringify(PRESETS.helper.perms));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','My Server','dummy',?,'ui')").run(JSON.stringify({ startsUp: true, filesRoot: dir }));
  db.prepare("INSERT INTO user_servers (user_id, server_id) SELECT id, 'mc' FROM users WHERE username = 'helper'").run();
  // The "agent" is a shell command, so the whole path (token, console-ctl, role limits, approvals) is exercised for real.
  let command = "true";
  const fake = { label: "Fake", bins: () => ["fake"], assist: () => ["sh", "-c", command], restricted: true };
  const services = createServices({ db, dataDir: path.join(base, "data") });
  const app = buildApp({ db, services, dataDir: path.join(base, "data"), assistantOptions: { agents: { fake }, which: async () => true }, pluginOptions: { boot: false } });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const as = async (who, pw) => {
    const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
    const cookie = `console_session=${res.cookies.find((x) => x.name === "console_session")?.value}`;
    const call = (m, u, p) => app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" || m === "DELETE" ? undefined : (p ?? {}) });
    return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p) };
  };
  return { app, as, setCommand: (c) => (command = c) };
}
const ask = async (u, text) => {
  const r = await u.post("/api/assistant/message", { text });
  assert.equal(r.statusCode, 200, r.body);
  return r.json().turnId;
};
const finish = (u, id) => until(async () => { const t = (await u.get(`/api/assistant/turns/${id}`)).json(); return t.state !== "running" ? t : null; });

test("assistant: off until an owner enables it; owners pick the agent", async () => {
  const f = await setup();
  const boss = await f.as("boss", "pw-admin-123");
  assert.equal((await boss.post("/api/assistant/message", { text: "hi" })).statusCode, 403);
  assert.equal((await boss.put("/api/assistant", { agent: "nope" })).statusCode, 400);
  assert.equal((await boss.put("/api/assistant", { enabled: true, agent: "fake" })).statusCode, 200);
  const helper = await as_(f, "helper");
  assert.equal((await helper.put("/api/assistant", { enabled: false })).statusCode, 403, "only owners change settings");
  await f.app.close();
});
const as_ = (f, who) => f.as(who, who === "helper" ? "pw-helper-123" : "pw-admin-123");

test("assistant: acts as the person who asked, with exactly their permissions, and can't manage people", async () => {
  const f = await setup();
  const boss = await f.as("boss", "pw-admin-123");
  await boss.put("/api/assistant", { enabled: true, agent: "fake" });
  const helper = await as_(f, "helper");

  f.setCommand("console-ctl api GET /api/me; console-ctl api GET /api/users; console-ctl api GET /api/servers/mc/mc/props");
  const t = await finish(helper, await ask(helper, "who am I?"));
  assert.equal(t.state, "done");
  assert.match(t.reply, /"username":"helper"/, "runs as helper, not as the owner");
  assert.match(t.reply, /HTTP 403/, "user management is off limits to the agent");
  assert.doesNotMatch(t.reply, /"username":"boss"/);

  f.setCommand("console-ctl routes players");
  const r = await finish(helper, await ask(helper, "what can you do?"));
  assert.match(r.reply, /players/);
  assert.doesNotMatch(r.reply, /\/api\/users|\/api\/invites|\/api\/assistant\/message/);

  const hist = (await helper.get("/api/assistant")).json().history;
  assert.deepEqual(hist.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  await f.app.close();
});

test("assistant: risky calls wait for a click; deny stops them, approve lets exactly that call through", async () => {
  const f = await setup();
  const boss = await f.as("boss", "pw-admin-123");
  await boss.put("/api/assistant", { enabled: true, agent: "fake" });

  f.setCommand("console-ctl api POST /api/servers/mc/restart");
  const id = await ask(boss, "restart it");
  const pending = await until(async () => { const t = (await boss.get(`/api/assistant/turns/${id}`)).json(); return t.approvals[0] ?? null; });
  assert.ok(pending, "an approval card shows up");
  assert.match(pending.summary, /restart/);
  assert.equal((await boss.post(`/api/assistant/approvals/${pending.id}`, { approve: true })).statusCode, 200);
  const done = await finish(boss, id);
  assert.match(done.reply, /HTTP (200|4\d\d)/);
  assert.doesNotMatch(done.reply, /needsApproval/, "went through after approval");

  f.setCommand("console-ctl api DELETE /api/servers/mc");
  const id2 = await ask(boss, "delete my server");
  const p2 = await until(async () => (await boss.get(`/api/assistant/turns/${id2}`)).json().approvals[0] ?? null);
  await boss.post(`/api/assistant/approvals/${p2.id}`, { approve: false });
  const denied = await finish(boss, id2);
  assert.match(denied.reply, /said no/);
  assert.equal((await boss.get("/api/servers")).json().some((s) => s.id === "mc"), true, "server still exists");
  await f.app.close();
});

test("assistant: agents that can't be sandboxed are owner-only", async () => {
  const f = await setup();
  const boss = await f.as("boss", "pw-admin-123");
  await boss.put("/api/assistant", { enabled: true, agent: "custom", custom: "echo hi" });
  const helper = await as_(f, "helper");
  const r = await helper.post("/api/assistant/message", { text: "hello" });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().error, /sandboxed/);
  await f.app.close();
});
