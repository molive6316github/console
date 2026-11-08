import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { parseKey, createLinuxUsers, LinuxUserError } from "../src/linuxusers.js";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");

// A real ed25519 public key (throwaway, generated for tests)
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGv1c2VyLXRlc3Qta2V5LW5vdC1yZWFsLWp1c3Qtc2hhcGU= test@laptop";
const KEY2 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHNlY29uZC10ZXN0LWtleS1ub3QtcmVhbC1qdXN0LXNoYXA= other@phone";

function setup({ safeMode = false, terminalOptions = {}, linuxOptions = {} } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-adv-"));
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  const services = createServices({ db, dataDir: path.join(base, "data"), terminalOptions: { shell: "/bin/sh", checkMs: 40, ...terminalOptions }, linuxOptions });
  const app = buildApp({ db, services, safeMode, dataDir: path.join(base, "data") });
  return { app, db, base, services };
}
async function login(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  return `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
}
const call = (f, cookie) => (method, url, payload) => f.app.inject({ method, url, headers: { cookie }, payload: method === "GET" ? undefined : (payload ?? {}) });

function connect(url, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => resolve({ ws }));
    ws.on("unexpected-response", (_req, res) => resolve({ status: res.statusCode }));
    ws.on("error", () => {});
  });
}
const collect = (ws) => {
  const box = { text: "", closed: false };
  ws.on("message", (d) => (box.text += d.toString()));
  ws.on("close", () => (box.closed = true));
  return box;
};
const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// ---- terminal -----------------------------------------------------------------------
test("terminal: off by default, admin-only, same-origin only, never in safe mode", async () => {
  const f = setup();
  await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = f.app.server.address().port;
  const url = `ws://127.0.0.1:${port}/api/terminal`;
  const origin = `http://127.0.0.1:${port}`;
  try {
    const cookie = await login(f);
    assert.equal((await connect(url, { cookie, origin })).status, 403); // off
    assert.equal((await call(f, cookie)("GET", "/api/me")).json().features.terminal, false);
    assert.equal((await call(f, cookie)("PUT", "/api/settings", { terminalEnabled: true })).statusCode, 200);
    assert.equal((await call(f, cookie)("GET", "/api/me")).json().features.terminal, true);
    assert.equal((await connect(url, { origin })).status, 401); // no login
    const opCookie = await login(f, "op", "pw-operator-1");
    assert.equal((await connect(url, { cookie: opCookie, origin })).status, 403); // operator
    assert.equal((await call(f, opCookie)("PUT", "/api/settings", { terminalEnabled: false })).statusCode, 403); // can't flip it either
    assert.equal((await connect(url, { cookie, origin: "http://evil.example" })).status, 403); // other site
    assert.equal((await connect(url, { cookie })).status, 403); // no origin at all
    const ok = await connect(url, { cookie, origin });
    assert.ok(ok.ws);
    ok.ws.close();
  } finally {
    await f.app.close();
  }
  const safe = setup({ safeMode: true });
  await safe.app.listen({ port: 0, host: "127.0.0.1" });
  try {
    const p = safe.app.server.address().port;
    const cookie = await login(safe);
    assert.equal((await call(safe, cookie)("PUT", "/api/settings", { terminalEnabled: true })).statusCode, 403);
    safe.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal_enabled','1')").run();
    assert.equal((await connect(`ws://127.0.0.1:${p}/api/terminal`, { cookie, origin: `http://127.0.0.1:${p}` })).status, 403);
  } finally {
    await safe.app.close();
  }
});

test("terminal: a real shell, secrets stripped from its environment, session audited, ends when turned off", async () => {
  process.env.CONSOLE_ADMIN_PASSWORD = "hunter2-should-not-leak";
  process.env.CF_API_TOKEN = "cf-should-not-leak";
  const f = setup();
  await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = f.app.server.address().port;
  try {
    const cookie = await login(f);
    await call(f, cookie)("PUT", "/api/settings", { terminalEnabled: true });
    const { ws } = await connect(`ws://127.0.0.1:${port}/api/terminal?cols=100&rows=30`, { cookie, origin: `http://127.0.0.1:${port}` });
    const out = collect(ws);
    ws.send(JSON.stringify({ t: "in", d: "echo $((6*7)) ; env | grep -c -e CONSOLE_ -e CF_API ; stty size\n" }));
    assert.ok(await until(() => /42/.test(out.text) && /30 100/.test(out.text)), out.text);
    assert.doesNotMatch(out.text, /hunter2|cf-should-not-leak/);
    assert.match(out.text, /\n0\r?\n/); // grep -c found nothing
    ws.send(JSON.stringify({ t: "resize", cols: 120, rows: 40 }));
    ws.send(JSON.stringify({ t: "in", d: "stty size\n" }));
    assert.ok(await until(() => /40 120/.test(out.text)), out.text);
    ws.send("not json"); // garbage is ignored, not fatal
    ws.send(JSON.stringify({ t: "in", d: "echo still-alive\n" }));
    assert.ok(await until(() => /still-alive/.test(out.text)));
    assert.equal(f.services.terminal.count(), 1);
    await call(f, cookie)("PUT", "/api/settings", { terminalEnabled: false });
    assert.ok(await until(() => out.closed), "turning it off must end the session");
    assert.match(out.text, /turned off/);
    const acts = f.db.prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'terminal%' ORDER BY id").all().map((r) => r.action);
    assert.deepEqual(acts.filter((a) => a === "terminal_open" || a === "terminal_close"), ["terminal_open", "terminal_close"]);
    assert.equal(f.services.terminal.count(), 0);
    // keystrokes must not be in the audit log
    assert.ok(!JSON.stringify(f.db.prepare("SELECT * FROM audit_log").all()).includes("still-alive"));
  } finally {
    delete process.env.CONSOLE_ADMIN_PASSWORD;
    delete process.env.CF_API_TOKEN;
    await f.app.close();
  }
});

test("terminal: signing out closes it, and only 3 can be open at once", async () => {
  const f = setup();
  await f.app.listen({ port: 0, host: "127.0.0.1" });
  const port = f.app.server.address().port;
  try {
    const cookie = await login(f);
    await call(f, cookie)("PUT", "/api/settings", { terminalEnabled: true });
    const o = { cookie, origin: `http://127.0.0.1:${port}` };
    const url = `ws://127.0.0.1:${port}/api/terminal`;
    const conns = [];
    for (let i = 0; i < 3; i++) conns.push((await connect(url, o)).ws);
    assert.equal((await connect(url, o)).status, 429);
    const out = collect(conns[0]);
    await call(f, cookie)("POST", "/api/logout", {});
    assert.ok(await until(() => out.closed), "logout must end the shell");
    assert.match(out.text, /signed out/);
    conns.forEach((c) => c.close());
  } finally {
    await f.app.close();
  }
});

// ---- Linux users ------------------------------------------------------------------------
function linuxFixture() {
  const base = mkdtempSync(path.join(tmpdir(), "console-linux-"));
  const passwd = path.join(base, "passwd");
  const group = path.join(base, "group");
  writeFileSync(passwd, ["root:x:0:0:root:/root:/bin/bash", "daemon:x:1:1::/:/usr/sbin/nologin", "opc:x:1000:1000::/home/opc:/bin/bash", "alice:x:1001:1001::/home/alice:/bin/bash", "nobody:x:65534:65534::/:/sbin/nologin", ""].join("\n"));
  writeFileSync(group, ["root:x:0:", "wheel:x:10:opc", "opc:x:1000:", ""].join("\n"));
  const calls = path.join(base, "calls.jsonl");
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  // fake sudo: logs argv and stdin as JSON; `cat <authorized_keys>` answers from a fixture file
  writeFileSync(path.join(bin, "sudo"), `#!/usr/bin/env node
const fs = require("fs");
const args = process.argv.slice(2);
let input = ""; try { input = fs.readFileSync(0, "utf8"); } catch {}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args, input }) + "\\n");
if (args[1] === "useradd") fs.appendFileSync(${JSON.stringify(passwd)}, args.at(-1) + ":x:1002:1002::/home/" + args.at(-1) + ":/bin/bash\\n");
if (args.includes("cat") && args.at(-1).endsWith("authorized_keys")) {
  const f = ${JSON.stringify(path.join(base, "keys"))};
  if (!fs.existsSync(f)) { console.error("cat: No such file or directory"); process.exit(1); }
  process.stdout.write(fs.readFileSync(f));
}
if (args.includes("sh") && input) fs.writeFileSync(${JSON.stringify(path.join(base, "keys"))}, (args.join(" ").includes(">>") && fs.existsSync(${JSON.stringify(path.join(base, "keys"))}) ? fs.readFileSync(${JSON.stringify(path.join(base, "keys"))}, "utf8") : "") + input);
`);
  chmodSync(path.join(bin, "sudo"), 0o755);
  const old = process.env.PATH;
  const lu = createLinuxUsers({ passwdFile: passwd, groupFile: group, selfUser: "opc" });
  const log = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { lu, log, base, activate: () => (process.env.PATH = `${bin}:${old}`), restore: () => (process.env.PATH = old) };
}

test("ssh keys: only real public keys pass, one line, no options, fingerprint computed", () => {
  const k = parseKey(KEY);
  assert.equal(k.type, "ssh-ed25519");
  assert.match(k.fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/);
  assert.equal(k.comment, "test@laptop");
  for (const bad of ["", "hello", `command="rm -rf /" ${KEY}`, `${KEY}\n${KEY2}`, "ssh-ed25519 AAAA", "-----BEGIN OPENSSH PRIVATE KEY-----", KEY.replace("ssh-ed25519 ", "ssh-rsa "), `${KEY}\u0007`]) {
    assert.throws(() => parseKey(bad), LinuxUserError, JSON.stringify(bad).slice(0, 40));
  }
});

test("linux users: lists real accounts only, with sudo status and which one is Console's own", () => {
  const { lu } = linuxFixture();
  const l = lu.list();
  assert.deepEqual(l.users.map((u) => u.name), ["opc", "alice"]);
  assert.equal(l.sudoGroup, "wheel");
  assert.deepEqual(l.users.map((u) => u.sudo), [true, false]);
  assert.equal(l.users[0].self, true);
});

test("linux users: create, sudo, keys go through sudo with plain argv, and the key is passed as data", async () => {
  const x = linuxFixture();
  x.activate();
  try {
    await x.lu.create({ name: "bob", sudo: true, key: KEY });
    const calls = x.log();
    assert.deepEqual(calls[0].args, ["-n", "useradd", "-m", "-s", "/bin/bash", "bob"]);
    assert.deepEqual(calls[1].args, ["-n", "usermod", "-aG", "wheel", "bob"]);
    const keyWrite = calls.find((c) => c.args.includes("sh"));
    assert.deepEqual(keyWrite.args.slice(0, 4), ["-n", "-u", "bob", "-H"]);
    assert.equal(keyWrite.input, KEY + "\n");
  } finally {
    x.restore();
  }
  const y = linuxFixture();
  y.activate();
  try {
    const fp = await y.lu.addKey("alice", KEY);
    assert.equal(fp, parseKey(KEY).fingerprint);
    const write = y.log().find((c) => c.args.includes("sh"));
    assert.equal(write.input, KEY + "\n");
    assert.ok(!write.args.join(" ").includes("AAAAC3")); // the key is never on the command line
    assert.deepEqual((await y.lu.keys("alice")).map((k) => k.comment), ["test@laptop"]);
    await assert.rejects(y.lu.addKey("alice", KEY), /already on this account/);
    await y.lu.addKey("alice", KEY2);
    assert.equal((await y.lu.keys("alice")).length, 2);
    await y.lu.removeKey("alice", parseKey(KEY).fingerprint);
    assert.deepEqual((await y.lu.keys("alice")).map((k) => k.comment), ["other@phone"]);
    await y.lu.setSudo("alice", true);
    assert.deepEqual(y.log().at(-1).args, ["-n", "usermod", "-aG", "wheel", "alice"]);
    await y.lu.setSudo("alice", false);
    assert.deepEqual(y.log().at(-1).args, ["-n", "gpasswd", "-d", "alice", "wheel"]);
  } finally {
    y.restore();
  }
});

test("linux users: the dangerous moves are refused before sudo is ever called", async () => {
  const x = linuxFixture();
  x.activate();
  try {
    const refuse = async (p, re) => (await assert.rejects(p, re), assert.equal(x.log().length, 0, "sudo must not have been called"));
    await refuse(x.lu.create({ name: "root" }), /reserved/);
    await refuse(x.lu.create({ name: "alice" }), /already exists/);
    await refuse(x.lu.create({ name: "Bad Name" }), /lowercase/);
    await refuse(x.lu.create({ name: "-rf" }), /lowercase/);
    await refuse(x.lu.create({ name: "x; reboot" }), /lowercase/);
    await refuse(x.lu.create({ name: "carol", key: "command=\"x\" " + KEY }), /public SSH key/);
    await refuse(x.lu.remove("opc", { confirm: "opc" }), /lock Console out/); // Console's own account
    await refuse(x.lu.setSudo("opc", false), /lock Console out/);
    await refuse(x.lu.remove("root", { confirm: "root" }), /System accounts|valid user/);
    await refuse(x.lu.remove("daemon", { confirm: "daemon" }), /System accounts/);
    await refuse(x.lu.remove("alice", { confirm: "nope" }), /Type the user's name/);
    await refuse(x.lu.removeKey("alice", "SHA256:short"), /Bad key/);
    await refuse(x.lu.keys("../../etc"), /valid user/);
    // the allowed path still works
    await x.lu.remove("alice", { confirm: "alice", deleteHome: true });
    assert.deepEqual(x.log().at(-1).args, ["-n", "userdel", "-r", "alice"]);
  } finally {
    x.restore();
  }
});

test("linux users: API is admin-only, opt-in, and off in safe mode", async () => {
  const x = linuxFixture();
  const f = setup({ linuxOptions: { passwdFile: path.join(x.base, "passwd"), groupFile: path.join(x.base, "group"), selfUser: "opc" } });
  const cookie = await login(f);
  const api = call(f, cookie);
  assert.equal((await api("GET", "/api/linux/users")).statusCode, 403); // off by default
  assert.equal((await api("PUT", "/api/settings", { linuxUsersEnabled: true })).statusCode, 200);
  const l = await api("GET", "/api/linux/users");
  assert.equal(l.statusCode, 200);
  assert.deepEqual(l.json().users.map((u) => u.name), ["opc", "alice"]);
  const op = call(f, await login(f, "op", "pw-operator-1"));
  assert.equal((await op("GET", "/api/linux/users")).statusCode, 403);
  const bad = await api("POST", "/api/linux/users", { name: "root" });
  assert.equal(bad.statusCode, 400);
  const del = await api("POST", "/api/linux/users/opc/delete", { confirm: "opc" });
  assert.equal(del.statusCode, 400);
  assert.match(del.json().error, /lock Console out/);
  const audited = f.db.prepare("SELECT action, ok FROM audit_log WHERE action LIKE 'linux_%'").all();
  assert.ok(audited.some((a) => a.action === "linux_delete" && a.ok === 0), "refused attempts are audited too");
  const safe = setup({ safeMode: true });
  const sc = call(safe, await login(safe));
  assert.equal((await sc("GET", "/api/linux/users")).statusCode, 403);
});
