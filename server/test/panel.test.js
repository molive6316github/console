import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { ping } from "../src/mc/slp.js";
import { parsePerms, validatePerms, PRESETS } from "../src/perms.js";

// A tiny stand-in for a Minecraft server that answers the server-list ping.
const vi = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return Buffer.from(o); };
function fakeMc(json) {
  const body = Buffer.from(JSON.stringify(json));
  const payload = Buffer.concat([vi(0), vi(body.length), body]);
  const reply = Buffer.concat([vi(payload.length), payload]);
  const srv = net.createServer((s) => {
    s.on("data", () => { s.write(reply.subarray(0, 5)); setTimeout(() => s.write(reply.subarray(5)), 30); }); // split on purpose
    s.on("error", () => {});
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, port: srv.address().port })));
}

async function setup({ safeMode = false, mcPort } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-panel-"));
  const dir = path.join(base, "srv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), `motd=Hello\nserver-port=${mcPort ?? 25599}\nlevel-name=world\n`);
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','My Server','dummy',?,'ui')").run(JSON.stringify({ startsUp: true, filesRoot: dir }));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('other','Other','dummy','{}','ui')").run();
  const services = createServices({ db, dataDir: path.join(base, "data") });
  const app = buildApp({ db, services, safeMode, dataDir: path.join(base, "data") });
  return { app, db, dir, services };
}
async function as(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  const c = res.cookies.find((x) => x.name === "console_session");
  const cookie = `console_session=${c?.value}`;
  const call = (m, u, p) => f.app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" || m === "DELETE" ? undefined : (p ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p), del: (u) => call("DELETE", u), status: res.statusCode };
}
async function invite(f, boss, body, name, pw = "a-long-password-1") {
  const r = await boss.post("/api/invites", { serverId: "mc", ...body });
  assert.equal(r.statusCode, 200, r.body);
  const { token } = r.json();
  const acc = await f.app.inject({ method: "POST", url: `/api/invite/${token}/accept`, payload: { username: name, password: pw } });
  assert.equal(acc.statusCode, 200, acc.body);
  return as(f, name, pw);
}

test("permission helpers: defaults per role, validation, presets", () => {
  assert.deepEqual(parsePerms(null, "viewer"), ["console"]);
  assert.deepEqual(parsePerms(null, "operator"), ["console", "send", "power", "players"]);
  assert.ok(parsePerms(null, "admin").includes("files"));
  assert.deepEqual(parsePerms('["players","console"]', "viewer"), ["console", "players"], "stored order is normalised");
  assert.deepEqual(parsePerms('["root"]', "viewer"), ["console"], "garbage falls back to the role default");
  assert.equal(validatePerms(["console", "nope"]), null);
  assert.equal(validatePerms("console"), null);
  assert.ok(!PRESETS.admin.perms.includes("users"), "no preset can manage people");
});

test("invite link: shown once, single use, scoped to one server, logs the person in", async () => {
  const f = await setup();
  const boss = await as(f);
  const made = await boss.post("/api/invites", { serverId: "mc", preset: "moderator", note: "for Sam" });
  assert.equal(made.statusCode, 200, made.body);
  const { token } = made.json();
  assert.ok(token.length >= 30);
  const listed = (await boss.get("/api/invites?server=mc")).json();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].state, "open");
  assert.ok(!JSON.stringify(listed).includes(token), "the token is never shown again");
  assert.ok(!f.db.prepare("SELECT token_hash FROM invites").get().token_hash.includes(token), "only a hash is stored");

  const peek = await f.app.inject({ method: "GET", url: `/api/invite/${token}` });
  assert.equal(peek.statusCode, 200);
  assert.equal(peek.json().serverName, "My Server");
  assert.deepEqual(peek.json().perms, PRESETS.moderator.perms);

  // bad password / taken name do not burn the invite
  const weak = await f.app.inject({ method: "POST", url: `/api/invite/${token}/accept`, payload: { username: "sam", password: "short" } });
  assert.equal(weak.statusCode, 400);
  const taken = await f.app.inject({ method: "POST", url: `/api/invite/${token}/accept`, payload: { username: "boss", password: "a-long-password-1" } });
  assert.equal(taken.statusCode, 409);
  const ok = await f.app.inject({ method: "POST", url: `/api/invite/${token}/accept`, payload: { username: "sam", password: "a-long-password-1" } });
  assert.equal(ok.statusCode, 200, ok.body);
  const cookie = `console_session=${ok.cookies.find((c) => c.name === "console_session").value}`;
  const me = (await f.app.inject({ method: "GET", url: "/api/me", headers: { cookie } })).json();
  assert.equal(me.username, "sam");
  assert.deepEqual(me.perms, PRESETS.moderator.perms);

  const again = await f.app.inject({ method: "POST", url: `/api/invite/${token}/accept`, payload: { username: "sam2", password: "a-long-password-1" } });
  assert.equal(again.statusCode, 404, "a used link is dead");
  assert.equal((await f.app.inject({ method: "GET", url: `/api/invite/${token}` })).statusCode, 404);

  // sam sees only the invited server
  const sam = await as(f, "sam", "a-long-password-1");
  const servers = (await sam.get("/api/servers")).json();
  assert.deepEqual(servers.map((s) => s.id), ["mc"]);
  assert.equal((await sam.get("/api/servers/other")).statusCode, 404);
});

test("invite links expire, can be cancelled, and junk tokens are throttled", async () => {
  const f = await setup();
  const boss = await as(f);
  const { token, id } = (await boss.post("/api/invites", { serverId: "mc", preset: "helper" })).json();
  f.db.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, id);
  assert.equal((await f.app.inject({ method: "GET", url: `/api/invite/${token}` })).statusCode, 404);
  const second = (await boss.post("/api/invites", { serverId: "mc", preset: "helper" })).json();
  assert.equal((await boss.del(`/api/invites/${second.id}`)).statusCode, 200);
  assert.equal((await f.app.inject({ method: "GET", url: `/api/invite/${second.token}` })).statusCode, 404);
  let last;
  for (let i = 0; i < 12; i++) last = await f.app.inject({ method: "GET", url: `/api/invite/${"x".repeat(32)}${i}`, remoteAddress: "198.51.100.7" });
  assert.equal(last.statusCode, 429, "guessing is throttled");
});

test("invite validation: unknown role, empty or invalid permissions, bad expiry, bad server; only owners can invite", async () => {
  const f = await setup();
  const boss = await as(f);
  const bad = async (body) => (await boss.post("/api/invites", { serverId: "mc", ...body })).statusCode;
  assert.equal(await bad({ preset: "owner" }), 400);
  assert.equal(await bad({ perms: [] }), 400);
  assert.equal(await bad({ perms: ["files", "nuke"] }), 400);
  assert.equal(await bad({ preset: "helper", days: 99 }), 400);
  assert.equal((await boss.post("/api/invites", { serverId: "ghost", preset: "helper" })).statusCode, 404);
  const mod = await invite(f, boss, { preset: "admin" }, "adm");
  assert.equal((await mod.post("/api/invites", { serverId: "mc", preset: "helper" })).statusCode, 403, "even the Admin preset can't invite people");
  assert.equal((await mod.get("/api/users")).statusCode, 403);
});

test("what each role can and can't do", async () => {
  const f = await setup();
  const boss = await as(f);
  const helper = await invite(f, boss, { preset: "helper" }, "helper1");
  const mod = await invite(f, boss, { preset: "moderator" }, "mod1");
  const adm = await invite(f, boss, { preset: "admin" }, "adm1");
  const code = async (who, m, u, p) => { const r = await who[m](u, p); if (process.env.DBG && r.statusCode >= 400) console.log(m, u, r.statusCode, r.body.slice(0, 80)); return r.statusCode; };

  // helper: console + players only
  assert.equal(await code(helper, "get", "/api/servers/mc/logs"), 200);
  assert.equal(await code(helper, "get", "/api/servers/mc/mc/players"), 200);
  for (const [m, u, p] of [["post", "/api/servers/mc/command", { text: "say hi" }], ["post", "/api/servers/mc/restart"], ["get", "/api/servers/mc/files"], ["get", "/api/servers/mc/backups"], ["post", "/api/servers/mc/backups"], ["get", "/api/servers/mc/mc/properties"], ["get", "/api/servers/mc/mc/plugins"], ["get", "/api/audit?server=mc"], ["post", "/api/servers/mc/mc/backup"], ["get", "/api/schedules"], ["get", "/api/settings"], ["post", "/api/servers/mc/mc/github/push-config"]]) {
    assert.equal(await code(helper, m, u, p), 403, `${m} ${u}`);
  }
  // moderator: adds commands, power, activity; still no files / settings / plugins / backups
  assert.equal(await code(mod, "post", "/api/servers/mc/command", { text: "say hi" }), 400, "allowed through (the dummy driver just can't take commands)");
  assert.equal(await code(mod, "post", "/api/servers/mc/restart"), 200);
  assert.equal(await code(mod, "get", "/api/audit?server=mc"), 200);
  assert.equal(await code(mod, "get", "/api/audit"), 404, "no server given: not the whole log");
  assert.equal(await code(mod, "get", "/api/audit?server=other"), 404);
  for (const [m, u] of [["get", "/api/servers/mc/files"], ["get", "/api/servers/mc/mc/properties"], ["get", "/api/servers/mc/mc/plugins"], ["get", "/api/servers/mc/backups"]]) assert.equal(await code(mod, m, u), 403, u);
  // admin preset: everything for this server, nothing about people or the owner's GitHub
  assert.equal(await code(adm, "get", "/api/servers/mc/files"), 200);
  assert.equal(await code(adm, "get", "/api/servers/mc/backups"), 200);
  assert.equal(await code(adm, "get", "/api/servers/mc/mc/properties"), 200);
  assert.equal(await code(adm, "get", "/api/servers/mc/mc/plugins"), 200);
  for (const [m, u] of [["get", "/api/users"], ["get", "/api/invites?server=mc"], ["get", "/api/servers/mc/mc/github"], ["get", "/api/settings"], ["get", "/api/schedules"]]) assert.equal(await code(adm, m, u), 403, u);
  assert.equal(await code(adm, "post", "/api/servers", { id: "x", name: "x", type: "dummy", target: {} }), 403, "can't add servers");
  assert.equal(await code(adm, "get", "/api/servers/other/logs"), 404, "other servers look like they don't exist");

  // the server list tells the UI what this person may do
  const s = (await mod.get("/api/servers/mc")).json();
  assert.equal(s.canAct, true);
  assert.equal(s.canEditFiles, false);
  assert.equal(s.canBackup, false);
});

test("changing someone's permissions takes effect at once and signs them out; owners can't be given a subset", async () => {
  const f = await setup();
  const boss = await as(f);
  const helper = await invite(f, boss, { preset: "helper" }, "h2");
  const id = f.db.prepare("SELECT id FROM users WHERE username = 'h2'").get().id;
  assert.equal((await helper.get("/api/servers/mc/backups")).statusCode, 403);
  const put = await boss.put(`/api/users/${id}`, { role: "viewer", allServers: false, servers: ["mc"], perms: ["console", "backups"] });
  assert.equal(put.statusCode, 200, put.body);
  assert.equal((await helper.get("/api/servers/mc/logs")).statusCode, 401, "old session is gone");
  const again = await as(f, "h2", "a-long-password-1");
  assert.equal((await again.get("/api/servers/mc/backups")).statusCode, 200);
  assert.equal((await again.get("/api/servers/mc/mc/players")).statusCode, 403);
  const bad = await boss.put(`/api/users/${id}`, { role: "viewer", allServers: false, servers: ["mc"], perms: ["console", "root"] });
  assert.equal(bad.statusCode, 400);
  const users = (await boss.get("/api/users")).json();
  assert.deepEqual(users.find((u) => u.username === "h2").perms, ["console", "backups"]);
  const adminId = f.db.prepare("SELECT id FROM users WHERE username = 'boss'").get().id;
  assert.equal((await boss.put(`/api/users/${adminId}`, { role: "admin", perms: ["console"] })).statusCode, 400);
});

test("safe mode: no invites", async () => {
  const f = await setup({ safeMode: true });
  const boss = await as(f);
  assert.equal((await boss.post("/api/invites", { serverId: "mc", preset: "helper" })).statusCode, 403);
});

// ---- live status + public page ----------------------------------------------------------------
test("server-list ping reads players, version and MOTD, even when the reply arrives in pieces", async () => {
  const { srv, port } = await fakeMc({ version: { name: "Paper 1.21.4" }, players: { online: 2, max: 20, sample: [{ name: "Steve" }, { name: "Alex" }] }, description: { text: "§aHello ", extra: [{ text: "world" }] } });
  try {
    const r = await ping("127.0.0.1", port);
    assert.equal(r.online, true);
    assert.equal(r.players.online, 2);
    assert.equal(r.players.max, 20);
    assert.deepEqual(r.players.names, ["Steve", "Alex"]);
    assert.equal(r.version, "Paper 1.21.4");
    assert.equal(r.motd, "Hello world");
  } finally { srv.close(); }
  assert.equal((await ping("127.0.0.1", port, { timeout: 500 })).online, false, "nothing listening = offline, no throw");
});

test("public status page: off by default, opt-in, shows only the safe facts, names are a separate switch", async () => {
  const { srv, port } = await fakeMc({ version: { name: "1.21.4" }, players: { online: 1, max: 10, sample: [{ name: "Steve" }] }, description: "Welcome" });
  try {
    const f = await setup({ mcPort: port });
    setSetting(f.db, "join_domain", "mc.example.com");
    const anon = () => f.app.inject({ method: "GET", url: "/api/public/status" }).then((r) => r.json());
    assert.deepEqual(await anon(), { enabled: false });
    const boss = await as(f);
    assert.equal((await as(f, "nobody", "x")).status, 401);
    assert.equal((await boss.put("/api/servers/mc/mc/public", { enabled: true })).statusCode, 200);
    const s = await anon();
    assert.equal(s.enabled, true);
    assert.equal(s.name, "My Server");
    assert.equal(s.online, true);
    assert.deepEqual(s.players, { online: 1, max: 10 });
    assert.equal(s.address, `mc.example.com:${port}`);
    const text = JSON.stringify(s);
    assert.ok(!/Steve|filesRoot|\/tmp|boss/.test(text), "no player names, paths or users");
    assert.equal((await boss.put("/api/servers/mc/mc/public", { names: true })).statusCode, 200);
    assert.deepEqual((await anon()).players.names, ["Steve"]);
    // an SRV record means players don't need the port
    await boss.put("/api/servers/mc/mc/public", { srv: true });
    assert.equal((await anon()).address, "mc.example.com");
    assert.equal((await boss.put("/api/servers/mc/mc/public", { domain: "not a domain!" })).statusCode, 400);
    assert.equal((await boss.put("/api/servers/mc/mc/public", { enabled: false })).statusCode, 200);
    assert.deepEqual(await anon(), { enabled: false });
    // only owners change it
    const helper = await invite(f, boss, { preset: "admin" }, "adm9");
    assert.equal((await helper.put("/api/servers/mc/mc/public", { enabled: true })).statusCode, 403);
  } finally { srv.close(); }
});

test("live status for signed-in people with console access; offline when the process is down", async () => {
  const { srv, port } = await fakeMc({ version: { name: "1.21.4" }, players: { online: 3, max: 8, sample: [] }, description: "x" });
  try {
    const f = await setup({ mcPort: port });
    const boss = await as(f);
    const helper = await invite(f, boss, { preset: "helper" }, "h3");
    const st = (await helper.get("/api/servers/mc/mc/status")).json();
    assert.equal(st.online, true);
    assert.equal(st.players.online, 3);
    assert.equal(st.level, "world");
    await boss.post("/api/servers/mc/stop");
    assert.equal((await helper.get("/api/servers/mc/mc/status")).json().online, false);
  } finally { srv.close(); }
});

test("people: owner adds someone directly; the password is generated once and the role's permissions apply", async () => {
  const f = await setup();
  const boss = await as(f);
  assert.equal((await boss.post("/api/people", { serverId: "mc", username: "jake", preset: "nope" })).statusCode, 400);
  const r = await boss.post("/api/people", { serverId: "mc", username: "jake", preset: "helper" });
  assert.equal(r.statusCode, 200);
  const { password } = r.json();
  assert.ok(password && password.length >= 10);
  const jake = await as(f, "jake", password);
  assert.equal(jake.status, 200);
  assert.equal((await jake.get("/api/servers/other/mc/players")).statusCode, 404, "only sees the server they were added to");
  assert.equal((await boss.post("/api/people", { serverId: "mc", username: "jake", preset: "helper" })).statusCode, 409);
  assert.equal((await jake.post("/api/people", { serverId: "mc", username: "x1", preset: "helper" })).statusCode, 403, "helpers can't add people");
});
