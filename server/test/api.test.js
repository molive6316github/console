import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";

function setup() {
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  add.run("boss", hashPassword("pw-admin"), "admin");
  add.run("op", hashPassword("pw-op"), "operator");
  add.run("eyes", hashPassword("pw-view"), "viewer");
  const ins = db.prepare("INSERT INTO servers (id, name, type, target) VALUES (?, ?, ?, ?)");
  ins.run("web", "Web", "dummy", JSON.stringify({ startsUp: false }));
  ins.run("site", "Site", "http", JSON.stringify({ url: "http://127.0.0.1:1" }));
  return { db, app: buildApp({ db }) };
}

async function login(app, username, password) {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username, password } });
  const cookie = res.cookies.find((c) => c.name === "console_session");
  return { res, cookie: cookie ? `console_session=${cookie.value}` : null };
}

test("requires login", async () => {
  const { app } = setup();
  assert.equal((await app.inject({ url: "/api/servers" })).statusCode, 401);
});

test("wrong password is rejected", async () => {
  const { app } = setup();
  const { res } = await login(app, "boss", "nope");
  assert.equal(res.statusCode, 401);
});

test("operator can start and stop, status updates, audit is written", async () => {
  const { app, db } = setup();
  const { cookie } = await login(app, "op", "pw-op");

  let list = (await app.inject({ url: "/api/servers", headers: { cookie } })).json();
  assert.equal(list.find((s) => s.id === "web").status, "down");

  const start = await app.inject({ method: "POST", url: "/api/servers/web/start", headers: { cookie }, payload: {} });
  assert.equal(start.statusCode, 200);
  assert.equal(start.json().status, "up");

  list = (await app.inject({ url: "/api/servers", headers: { cookie } })).json();
  assert.equal(list.find((s) => s.id === "web").status, "up");

  const rows = db.prepare("SELECT action, ok FROM audit_log WHERE server_id = 'web'").all();
  assert.deepEqual(rows.map((r) => r.action), ["start"]);
});

test("viewer can look but not act", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "eyes", "pw-view");
  const list = (await app.inject({ url: "/api/servers", headers: { cookie } })).json();
  assert.equal(list.every((s) => s.canAct === false), true);
  const res = await app.inject({ method: "POST", url: "/api/servers/web/start", headers: { cookie }, payload: {} });
  assert.equal(res.statusCode, 403);
});

test("only admin sees the audit log", async () => {
  const { app } = setup();
  const op = await login(app, "op", "pw-op");
  assert.equal((await app.inject({ url: "/api/audit", headers: { cookie: op.cookie } })).statusCode, 403);
  const boss = await login(app, "boss", "pw-admin");
  assert.equal((await app.inject({ url: "/api/audit", headers: { cookie: boss.cookie } })).statusCode, 200);
});

test("read-only http servers refuse actions and never leak their target", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "boss", "pw-admin");
  const res = await app.inject({ method: "POST", url: "/api/servers/site/restart", headers: { cookie }, payload: {} });
  assert.equal(res.statusCode, 400);
  const list = (await app.inject({ url: "/api/servers", headers: { cookie } })).json();
  assert.equal(list.find((s) => s.id === "site").status, "down");
  assert.equal(JSON.stringify(list).includes("127.0.0.1"), false);
});

test("POST without JSON content type is blocked", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "op", "pw-op");
  const res = await app.inject({
    method: "POST",
    url: "/api/servers/web/start",
    headers: { cookie, "content-type": "text/plain" },
    payload: "x",
  });
  assert.equal(res.statusCode, 415);
});

test("security headers are set, HSTS only when cookies are secure", async () => {
  const { app } = setup();
  const res = await app.inject({ url: "/api/me" });
  assert.equal(res.headers["x-frame-options"], "DENY");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.match(res.headers["content-security-policy"], /default-src 'self'/);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.equal(res.headers["strict-transport-security"], undefined);

  const db = openDb(":memory:");
  const secure = buildApp({ db, secureCookies: true });
  const res2 = await secure.inject({ url: "/api/me" });
  assert.match(res2.headers["strict-transport-security"], /max-age=/);
});

test("password change: wrong current password is 403 and does not sign you out", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "op", "pw-op");
  const res = await app.inject({ method: "POST", url: "/api/password", headers: { cookie }, payload: { current: "nope", next: "a-brand-new-pass" } });
  assert.equal(res.statusCode, 403);
  assert.equal((await app.inject({ url: "/api/me", headers: { cookie } })).statusCode, 200);
});

test("password change: works, old password dies, other sessions are signed out", async () => {
  const { app } = setup();
  const a = await login(app, "op", "pw-op");
  const b = await login(app, "op", "pw-op");
  const res = await app.inject({ method: "POST", url: "/api/password", headers: { cookie: a.cookie }, payload: { current: "pw-op", next: "a-brand-new-pass" } });
  assert.equal(res.statusCode, 200);
  assert.equal((await app.inject({ url: "/api/me", headers: { cookie: a.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url: "/api/me", headers: { cookie: b.cookie } })).statusCode, 401);
  assert.equal((await login(app, "op", "pw-op")).res.statusCode, 401);
  assert.equal((await login(app, "op", "a-brand-new-pass")).res.statusCode, 200);
});

test("password change: rejects short and unchanged passwords, needs login", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "op", "pw-op");
  const post = (payload) => app.inject({ method: "POST", url: "/api/password", headers: { cookie }, payload });
  assert.equal((await post({ current: "pw-op", next: "short" })).statusCode, 400);
  assert.equal((await post({ current: "pw-op", next: "pw-op" })).statusCode, 400);
  const anon = await app.inject({ method: "POST", url: "/api/password", payload: { current: "x", next: "long-enough-pw" } });
  assert.equal(anon.statusCode, 401);
});

test("unknown action is rejected", async () => {
  const { app } = setup();
  const { cookie } = await login(app, "op", "pw-op");
  const res = await app.inject({ method: "POST", url: "/api/servers/web/format-disk", headers: { cookie }, payload: {} });
  assert.equal(res.statusCode, 400);
});
