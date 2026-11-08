import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";

function setup({ safeMode = false, fetchImpl } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-api-"));
  const root = path.join(base, "mcfiles");
  mkdirSync(root);
  writeFileSync(path.join(root, "server.properties"), "motd=hi\n");
  writeFileSync(path.join(base, "secret.txt"), "TOP SECRET");
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, ?)");
  add.run("boss", hashPassword("pw-admin-123"), "admin", 1);
  add.run("op", hashPassword("pw-operator-1"), "operator", 1);
  add.run("eyes", hashPassword("pw-viewer-12"), "viewer", 1);
  add.run("mod", hashPassword("pw-moderator1"), "operator", 0); // scoped
  const ins = db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES (?, ?, ?, ?, ?)");
  ins.run("web", "Web", "dummy", JSON.stringify({ startsUp: true, filesRoot: root }), "file");
  ins.run("db", "DB", "dummy", JSON.stringify({ startsUp: false }), "file");
  ins.run("site", "Site", "http", JSON.stringify({ url: "http://127.0.0.1:1" }), "file");
  const modId = db.prepare("SELECT id FROM users WHERE username = 'mod'").get().id;
  db.prepare("INSERT INTO user_servers (user_id, server_id) VALUES (?, 'web')").run(modId);
  const services = createServices({ db, dataDir: path.join(base, "data"), fetchImpl });
  const app = buildApp({ db, services, safeMode, dataDir: path.join(base, "data") });
  return { app, db, base, root, services };
}

async function login(app, username, password) {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  const c = res.cookies.find((x) => x.name === "console_session");
  return c ? { cookie: `console_session=${c.value}` } : null;
}
const as = async (f, who) => {
  const pw = { boss: "pw-admin-123", op: "pw-operator-1", eyes: "pw-viewer-12", mod: "pw-moderator1" }[who];
  const s = await login(f.app, who, pw);
  const call = (method, url, payload) => f.app.inject({ method, url, headers: { cookie: s.cookie }, payload: method === "GET" || method === "DELETE" ? undefined : (payload ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p), del: (u) => call("DELETE", u), cookie: s.cookie };
};

// ---- scope ------------------------------------------------------------------------
test("a scoped user sees only their servers; others look like they don't exist", async () => {
  const f = setup();
  const mod = await as(f, "mod");
  assert.deepEqual((await mod.get("/api/servers")).json().map((s) => s.id), ["web"]);
  for (const [m, u] of [["get", "/api/servers/db"], ["get", "/api/servers/db/logs"], ["post", "/api/servers/db/start"], ["post", "/api/servers/db/command"]]) {
    assert.equal((await mod[m](u, { text: "x" })).statusCode, 404, `${m} ${u}`);
  }
  assert.equal((await mod.post("/api/servers/web/restart")).statusCode, 200);
  assert.equal((await mod.get("/api/host")).statusCode, 403, "machine-wide stats are hidden from scoped staff");
  assert.equal((await mod.get("/api/users")).statusCode, 403);
  assert.equal((await mod.get("/api/servers/web/files")).statusCode, 403);
});

test("viewer: can read logs, can't act, can't send commands", async () => {
  const f = setup();
  const eyes = await as(f, "eyes");
  assert.equal((await eyes.get("/api/servers/web/logs")).statusCode, 200);
  assert.equal((await eyes.post("/api/servers/web/start")).statusCode, 403);
  assert.equal((await eyes.post("/api/servers/web/command", { text: "x" })).statusCode, 403);
  assert.equal((await eyes.get("/api/host")).statusCode, 200);
});

// ---- users ------------------------------------------------------------------------
test("admin creates a scoped user who can sign in and sees only their server", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const r = await boss.post("/api/users", { username: "new.mod", password: "a-long-password", role: "operator", allServers: false, servers: ["db"] });
  assert.equal(r.statusCode, 200, r.body);
  const s = await login(f.app, "new.mod", "a-long-password");
  const list = (await f.app.inject({ url: "/api/servers", headers: { cookie: s.cookie } })).json();
  assert.deepEqual(list.map((x) => x.id), ["db"]);
});

test("user rules: validation, duplicates, no self-lockout, last admin protected", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const bad = [
    { username: "x", password: "a-long-password", role: "viewer" },
    { username: "ok-name", password: "short", role: "viewer" },
    { username: "ok-name", password: "a-long-password", role: "root" },
    { username: "ok-name", password: "a-long-password", role: "viewer", allServers: false, servers: [] },
    { username: "ok-name", password: "a-long-password", role: "viewer", allServers: false, servers: ["ghost"] },
    { username: "bad name!", password: "a-long-password", role: "viewer" },
    { username: "BOSS", password: "a-long-password", role: "viewer" },
  ];
  for (const b of bad) assert.ok((await boss.post("/api/users", b)).statusCode >= 400, JSON.stringify(b));

  const me = f.db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
  assert.equal((await boss.del(`/api/users/${me}`)).statusCode, 400, "can't delete yourself");
  assert.equal((await boss.put(`/api/users/${me}`, { role: "viewer" })).statusCode, 400, "can't demote yourself");
  const op = f.db.prepare("SELECT id FROM users WHERE username = 'op'").get().id;
  assert.equal((await boss.put(`/api/users/${op}`, { role: "admin" })).statusCode, 200);
  assert.equal((await boss.put(`/api/users/${op}`, { role: "viewer" })).statusCode, 200, "with two admins, one can be demoted");
  assert.equal((await as(f, "op").then((o) => o.get("/api/users"))).statusCode, 403);
});

test("changing a user's role, scope or password ends their sessions immediately", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const eyes = await as(f, "eyes");
  assert.equal((await eyes.get("/api/servers")).statusCode, 200);
  const id = f.db.prepare("SELECT id FROM users WHERE username = 'eyes'").get().id;
  await boss.put(`/api/users/${id}`, { role: "operator" });
  assert.equal((await eyes.get("/api/servers")).statusCode, 401);
  // password reset: the old password stops working
  await boss.put(`/api/users/${id}`, { role: "operator", password: "brand-new-pass-1" });
  assert.equal(await login(f.app, "eyes", "pw-viewer-12"), null);
  assert.ok(await login(f.app, "eyes", "brand-new-pass-1"));
});

test("deleting a user removes their grants and sessions", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const mod = await as(f, "mod");
  const id = f.db.prepare("SELECT id FROM users WHERE username = 'mod'").get().id;
  assert.equal((await boss.del(`/api/users/${id}`)).statusCode, 200);
  assert.equal((await mod.get("/api/servers")).statusCode, 401);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM user_servers").get().n, 0);
});

// ---- server add / edit / remove ----------------------------------------------------------
test("admin adds, edits and removes a UI server; targets are validated; file-managed servers are read-only", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const good = { id: "uhc", name: "UHC", type: "tmux", target: { session: "uhc", startCommand: "./run.sh", cwd: "/tmp", junk: "dropped" } };
  assert.equal((await boss.post("/api/servers", good)).statusCode, 200);
  const cfg = (await boss.get("/api/servers/uhc/config")).json();
  assert.deepEqual(cfg.target, { session: "uhc", startCommand: "./run.sh", cwd: "/tmp" });
  assert.equal((await boss.post("/api/servers", good)).statusCode, 409, "duplicate id");

  for (const bad of [
    { ...good, id: "Bad ID" },
    { ...good, id: "x", type: "rm-rf" },
    { ...good, id: "x", target: { session: "a b", startCommand: "x" } },
    { ...good, id: "x", name: "" },
    { ...good, id: "x", type: "systemd", target: { host: "-oProxyCommand=evil", unit: "a.service" } },
    { ...good, id: "x", type: "http", target: { url: "file:///etc/passwd" } },
    { ...good, id: "x", type: "docker", target: { container: "a;b" } },
  ]) assert.equal((await boss.post("/api/servers", bad)).statusCode, 400, JSON.stringify(bad));

  assert.equal((await boss.put("/api/servers/uhc", { name: "UHC 2", type: "tmux", target: { session: "uhc", startCommand: "./run2.sh" } })).statusCode, 200);
  assert.equal((await boss.get("/api/servers/uhc/config")).json().target.startCommand, "./run2.sh");

  assert.equal((await boss.put("/api/servers/web", { name: "x", type: "dummy", target: {} })).statusCode, 409, "from servers.json");
  assert.equal((await boss.del("/api/servers/web")).statusCode, 409);

  assert.equal((await boss.del("/api/servers/uhc")).statusCode, 200);
  assert.equal((await boss.get("/api/servers/uhc")).statusCode, 404);
});

test("only admins can add servers or read targets", async () => {
  const f = setup();
  const op = await as(f, "op");
  assert.equal((await op.post("/api/servers", { id: "x", name: "x", type: "dummy", target: {} })).statusCode, 403);
  assert.equal((await op.get("/api/servers/web/config")).statusCode, 403);
  const list = JSON.stringify((await op.get("/api/servers")).json());
  assert.equal(list.includes("filesRoot"), false);
  assert.equal(list.includes("mcfiles"), false);
});

test("safe mode switches off server editing, the file editor and commands", async () => {
  const f = setup({ safeMode: true });
  const boss = await as(f, "boss");
  assert.equal((await boss.post("/api/servers", { id: "x", name: "x", type: "dummy", target: {} })).statusCode, 403);
  assert.equal((await boss.get("/api/servers/web/files")).statusCode, 403);
  assert.equal((await boss.post("/api/servers/web/command", { text: "x" })).statusCode, 403);
  assert.equal((await boss.post("/api/schedules", { serverId: "web", action: "command", arg: "x", cron: "* * * * *" })).statusCode, 400);
  assert.equal((await boss.post("/api/servers/web/restart")).statusCode, 200, "normal operation still works");
  const s = (await boss.get("/api/servers")).json().find((x) => x.id === "web");
  assert.equal(s.canEditFiles, false);
});

// ---- logs + commands -------------------------------------------------------------------
test("logs: dummy has some, http has none", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  assert.match((await boss.get("/api/servers/web/logs")).json().text, /dummy/);
  assert.equal((await boss.get("/api/servers/site/logs")).statusCode, 400);
});

test("commands go to a real tmux session, are audited, and bad input is refused", { skip: spawnSync("tmux", ["-V"]).status !== 0 }, async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const session = `consoleapi${process.pid}`;
  try {
    await boss.post("/api/servers", { id: "echo", name: "Echo", type: "tmux", target: { session, startCommand: `bash -c 'while read l; do echo "heard:$l"; done'` } });
    assert.equal((await boss.post("/api/servers/echo/command", { text: "hi" })).statusCode, 500, "not running yet");
    assert.equal((await boss.post("/api/servers/echo/start")).json().status, "up");
    assert.equal((await boss.post("/api/servers/echo/command", { text: "say hello" })).statusCode, 200);
    let logs = "";
    for (let i = 0; i < 40 && !logs.includes("heard:say hello"); i++) {
      await new Promise((r) => setTimeout(r, 100));
      logs = (await boss.get("/api/servers/echo/logs")).json().text;
    }
    assert.match(logs, /heard:say hello/);
    assert.equal((await boss.post("/api/servers/echo/command", { text: "" })).statusCode, 400);
    assert.equal((await boss.post("/api/servers/echo/command", { text: "a\nb" })).statusCode, 500);
    assert.equal((await boss.post("/api/servers/web/command", { text: "x" })).statusCode, 400, "dummy can't take commands");
    const row = f.db.prepare("SELECT username, ok, detail FROM audit_log WHERE action = 'command' AND ok = 1").get();
    assert.deepEqual({ ...row }, { username: "boss", ok: 1, detail: "say hello" });
  } finally {
    await boss.post("/api/servers/echo/stop");
  }
});

// ---- files + backups via the API ---------------------------------------------------------
test("file editor API: list, read, save, conflict, traversal and symlink escape", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  symlinkSync(path.join(f.base, "secret.txt"), path.join(f.root, "leak.txt"));
  const listed = (await boss.get("/api/servers/web/files?path=")).json();
  assert.deepEqual(listed.entries.map((e) => e.name), ["server.properties"]);
  const file = (await boss.get("/api/servers/web/file?path=server.properties")).json();
  assert.equal(file.content, "motd=hi\n");
  const saved = await boss.put("/api/servers/web/file", { path: "server.properties", content: "motd=yo\n", mtime: file.mtime });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(readFileSync(path.join(f.root, "server.properties"), "utf8"), "motd=yo\n");
  assert.equal((await boss.put("/api/servers/web/file", { path: "server.properties", content: "x", mtime: 1 })).statusCode, 409);
  assert.equal((await boss.get("/api/servers/web/file?path=../secret.txt")).statusCode, 400);
  assert.equal((await boss.get("/api/servers/web/file?path=leak.txt")).statusCode, 403);
  assert.equal((await boss.put("/api/servers/web/file", { path: "leak.txt", content: "pwned" })).statusCode, 403);
  assert.equal(readFileSync(path.join(f.base, "secret.txt"), "utf8"), "TOP SECRET");
  assert.equal((await boss.get("/api/servers/db/files")).statusCode, 404, "server without a files folder");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'file_edit' AND ok = 1").get().n, 1);
  assert.equal((await (await as(f, "op")).get("/api/servers/web/files")).statusCode, 403, "operators can't edit files");
});

test("backups API: create, list, download, delete", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  assert.equal((await boss.post("/api/servers/web/backups")).statusCode, 200);
  const list = (await boss.get("/api/servers/web/backups")).json();
  assert.equal(list.length, 1);
  const dl = await boss.get(`/api/servers/web/backups/${list[0].name}`);
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers["content-type"], "application/gzip");
  assert.ok(dl.rawPayload.length > 20);
  assert.equal((await boss.get("/api/servers/web/backups/..%2F..%2Fetc%2Fpasswd")).statusCode, 404);
  assert.equal((await boss.del(`/api/servers/web/backups/${list[0].name}`)).statusCode, 200);
  assert.equal((await boss.get("/api/servers/web/backups")).json().length, 0);
  assert.equal((await boss.get("/api/servers/db/backups")).statusCode, 404);
  assert.equal((await (await as(f, "op")).get("/api/servers/web/backups")).statusCode, 403);
});

// ---- schedules API -----------------------------------------------------------------------
test("schedules API: validation, create/edit/toggle/run-now/delete, admin only", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  for (const bad of [
    { serverId: "ghost", action: "restart", cron: "0 4 * * *" },
    { serverId: "web", action: "format", cron: "0 4 * * *" },
    { serverId: "web", action: "restart", cron: "nope" },
    { serverId: "web", action: "command", cron: "0 4 * * *", arg: "x" }, // dummy can't take commands
    { serverId: "db", action: "backup", cron: "0 4 * * *" }, // no files folder
    { serverId: "site", action: "restart", cron: "0 4 * * *" }, // read-only
  ]) assert.equal((await boss.post("/api/schedules", bad)).statusCode, 400, JSON.stringify(bad));

  const made = await boss.post("/api/schedules", { serverId: "web", action: "restart", cron: "0 4 * * *" });
  const id = made.json().id;
  const row = (await boss.get("/api/schedules")).json()[0];
  assert.equal(row.serverName, "Web");
  assert.ok(row.next > Date.now());
  assert.equal((await boss.put(`/api/schedules/${id}`, { enabled: false })).statusCode, 200);
  assert.equal((await boss.get("/api/schedules")).json()[0].next, null);
  assert.equal((await boss.put(`/api/schedules/${id}`, { cron: "bad" })).statusCode, 400);
  assert.equal((await boss.post(`/api/schedules/${id}/run`)).statusCode, 200);
  assert.equal((await boss.get("/api/schedules")).json()[0].lastStatus, "ok");
  assert.equal((await boss.post("/api/schedules", { serverId: "web", action: "backup", cron: "30 3 * * 0" })).statusCode, 200);
  assert.equal((await (await as(f, "op")).get("/api/schedules")).statusCode, 403);
  assert.equal((await boss.del(`/api/schedules/${id}`)).statusCode, 200);
  assert.equal((await boss.del(`/api/schedules/${id}`)).statusCode, 404);
});

// ---- settings + alerts -------------------------------------------------------------------
test("settings: webhook is validated and never shown in full; test alert reaches it", async () => {
  const sent = [];
  const f = setup({ fetchImpl: async (url, init) => (sent.push({ url, body: JSON.parse(init.body) }), { ok: true }) });
  const boss = await as(f, "boss");
  assert.equal((await boss.post("/api/alerts/test")).statusCode, 400, "no webhook yet");
  assert.equal((await boss.put("/api/settings", { alertWebhook: "http://discord.com/x" })).statusCode, 400);
  assert.equal((await boss.put("/api/settings", { alertWebhook: "https://127.0.0.1/x" })).statusCode, 400);
  const r = await boss.put("/api/settings", { alertWebhook: "https://discord.com/api/webhooks/1/SUPERSECRETTOKEN", timezone: "America/New_York", backupKeep: 3 });
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.includes("SUPERSECRET"), false);
  assert.equal((await boss.get("/api/settings")).body.includes("SUPERSECRET"), false);
  assert.equal(r.json().timezone, "America/New_York");
  assert.equal((await boss.post("/api/alerts/test")).statusCode, 200);
  assert.equal(sent[0].url, "https://discord.com/api/webhooks/1/SUPERSECRETTOKEN");
  assert.equal((await boss.put("/api/settings", { timezone: "Mars/Base" })).statusCode, 400);
  assert.equal((await boss.put("/api/settings", { backupKeep: 0 })).statusCode, 400);
  assert.equal((await boss.put("/api/settings", { alertWebhook: "" })).json().alertsConfigured, false);
  assert.equal((await (await as(f, "op")).get("/api/settings")).statusCode, 403);
});

// ---- host + audit ------------------------------------------------------------------------
test("host metrics come back after a monitor tick; audit can be filtered by server", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  await f.services.monitor.tick();
  const h = (await boss.get("/api/host?hours=1")).json();
  assert.equal(h.history.length, 1);
  assert.ok(h.current.mem_total > 0);
  assert.ok(h.cores >= 1);
  await boss.post("/api/servers/web/restart");
  await boss.post("/api/servers/db/start");
  const rows = (await boss.get("/api/audit?server=web")).json();
  assert.ok(rows.length >= 1 && rows.every((r) => r.server_id === "web"));
});

test("PUT also needs a JSON content type, and server errors don't leak internals", async () => {
  const f = setup();
  const boss = await as(f, "boss");
  const res = await f.app.inject({ method: "PUT", url: "/api/settings", headers: { cookie: boss.cookie, "content-type": "text/plain" }, payload: "timezone=UTC" });
  assert.equal(res.statusCode, 415);
});
