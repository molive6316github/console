import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { cleanConfig } from "../src/sites.js";

test("config: bad colour and non-http links refused, products trimmed", () => {
  assert.throws(() => cleanConfig({ accent: "green" }), /Colour/);
  assert.throws(() => cleanConfig({ discord: "javascript:alert(1)" }), /http/);
  const c = cleanConfig({ products: [{ name: "VIP", price: "$5", url: "https://tebex.io/x" }, { name: "" }] });
  assert.equal(c.products.length, 1);
});

test("website: create, serve by Host, edit, route, delete", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "sites-"));
  const caddyDir = mkdtempSync(path.join(os.tmpdir(), "caddy-"));
  const ran = [];
  const db = openDb(":memory:");
  const insert = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)");
  insert.run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  insert.run("op", hashPassword("pw-operator-123"), "operator", Date.now());
  const services = createServices({ db, dataDir });
  const app = buildApp({ db, services, dataDir, siteOptions: { caddy: { sitesDir: caddyDir, caddyfile: "/x/Caddyfile" }, run: async (...a) => { ran.push(a.slice(0, 2).flat().join(" ")); return { code: 0, stdout: "", stderr: "" }; } } });
  const login = async (u, p) => { const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } }); return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`; };
  const boss = await login("boss", "pw-admin-123"), op = await login("op", "pw-operator-123");
  const call = (c, m, u, p) => app.inject({ method: m, url: u, headers: { cookie: c }, payload: p });

  assert.equal((await call(op, "GET", "/api/sites")).statusCode, 403);
  assert.equal((await call(boss, "POST", "/api/sites", { host: "nope" })).statusCode, 400);
  const made = await call(boss, "POST", "/api/sites", { host: "Shop.Example.com", template: "store", ip: "play.example.com" });
  assert.equal(made.statusCode, 200);
  assert.equal(made.json().routed, true);
  assert.ok(existsSync(path.join(caddyDir, "shop.example.com.caddy")));
  assert.match(readFileSync(path.join(caddyDir, "shop.example.com.caddy"), "utf8"), /reverse_proxy 127\.0\.0\.1:3000/);
  assert.ok(ran.some((x) => x.startsWith("sudo -n")));

  // served by Host name, with its own CSP, and the panel API is NOT reachable through that name
  const page = await app.inject({ method: "GET", url: "/", headers: { host: "shop.example.com" } });
  assert.match(page.body, /<script src="site.js">/);
  assert.match(page.headers["content-security-policy"], /img-src \* data:/);
  assert.equal((await app.inject({ method: "GET", url: "/api/me", headers: { host: "shop.example.com", cookie: boss } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/..%2f..%2fetc/passwd", headers: { host: "shop.example.com" } })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/", headers: { host: "shop.example.com" }, payload: {} })).statusCode, 405);
  assert.equal((await app.inject({ method: "GET", url: "/_status.json", headers: { host: "shop.example.com" } })).json().enabled, false);

  // edit with the form
  const put = await call(boss, "PUT", "/api/sites/shop.example.com/config", { title: "Shop", products: [{ name: "VIP", price: "$5", desc: "Perks", url: "https://tebex.io/vip" }] });
  assert.equal(put.statusCode, 200);
  const cfg = (await app.inject({ method: "GET", url: "/site.json", headers: { host: "shop.example.com" } })).json();
  assert.equal(cfg.title, "Shop");
  assert.equal(cfg.products[0].name, "VIP");
  assert.equal((await call(boss, "PUT", "/api/sites/shop.example.com/config", { accent: "nope" })).statusCode, 400);

  // raw files: simple names only
  assert.equal((await call(boss, "PUT", "/api/sites/shop.example.com/files/about.html", { text: "<p>hi</p>" })).statusCode, 200);
  assert.match((await app.inject({ method: "GET", url: "/about.html", headers: { host: "shop.example.com" } })).body, /hi/);
  assert.equal((await call(boss, "PUT", "/api/sites/shop.example.com/files/..%2Fevil.html", { text: "x" })).statusCode, 400);
  assert.equal((await call(boss, "PUT", "/api/sites/shop.example.com/files/run.sh", { text: "x" })).statusCode, 400);
  assert.equal((await call(boss, "DELETE", "/api/sites/shop.example.com/files/index.html")).statusCode, 400);

  // DNS helper now lists the site
  const list = (await call(boss, "GET", "/api/sites")).json();
  assert.equal(list.sites[0].host, "shop.example.com");

  assert.equal((await call(boss, "DELETE", "/api/sites/shop.example.com")).statusCode, 200);
  assert.equal(existsSync(path.join(caddyDir, "shop.example.com.caddy")), false);
  await new Promise((r) => setTimeout(r, 3100)); // host cache
  assert.doesNotMatch((await app.inject({ method: "GET", url: "/", headers: { host: "shop.example.com" } })).body, /site\.js/);
});

test("website without a writable Caddy folder still works and hands back the snippet", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "sites-"));
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  const app = buildApp({ db, services: createServices({ db, dataDir }), dataDir, siteOptions: { caddy: { sitesDir: "/nonexistent/sites" } } });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const c = `console_session=${r.cookies.find((x) => x.name === "console_session").value}`;
  const made = (await app.inject({ method: "POST", url: "/api/sites", headers: { cookie: c }, payload: { host: "a.example.com", template: "blank" } })).json();
  assert.equal(made.routed, false);
  assert.match(made.snippet, /reverse_proxy/);
});
