import { test } from "node:test";
import assert from "node:assert/strict";
import { Resolver } from "node:dns/promises";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { createNsConfig, createAuthority, createNameserverServer, delegationSteps, isWholeDomain } from "../src/nameserver.js";

test("whole domain vs sub-name, and what the person must do at the registrar", () => {
  assert.equal(isWholeDomain("example.com"), true);
  assert.equal(isWholeDomain("example.co.uk"), true);
  assert.equal(isWholeDomain("play.example.com"), false);
  assert.equal(delegationSteps("example.com", "1.2.3.4", ["ns1.example.com", "ns2.example.com"]).kind, "registrar");
  const s = delegationSteps("play.example.com", "1.2.3.4", ["ns1.example.com"]);
  assert.deepEqual(s.records.map((r) => [r.type, r.name, r.value]), [["NS", "play.example.com", "ns1.example.com"], ["A", "ns1.example.com", "1.2.3.4"]]);
});

test("the built-in nameserver answers real DNS queries and refuses everything else", async () => {
  const db = openDb(":memory:");
  const cfg = createNsConfig({ db, publicIp: () => "9.8.7.6", knownHosts: () => [{ name: "play.mc.example.com", srvPort: 25570 }, { name: "panel.mc.example.com" }, { name: "other.example.org" }] });
  assert.throws(() => cfg.set({ zones: ["not a domain"] }), /domain name/);
  assert.throws(() => cfg.set({ extra: [{ type: "A", name: "x.mc.example.com", value: "999.1.1.1" }] }), /IPv4/);
  cfg.set({ enabled: true, zones: ["mc.example.com"], extra: [{ type: "TXT", name: "mc.example.com", value: "hello" }, { type: "MX", name: "mc.example.com", value: "10 mail.example.net" }, { type: "CNAME", name: "www.mc.example.com", value: "panel.mc.example.com" }] });
  const server = createNameserverServer({ authority: createAuthority({ getConfig: () => cfg.get() }), port: 0, address: "127.0.0.1" });
  const udpPort = (await server.start()).port;
  const r = new Resolver({ timeout: 2000, tries: 1 });
  r.setServers([`127.0.0.1:${udpPort}`]);

  assert.deepEqual(await r.resolve4("play.mc.example.com"), ["9.8.7.6"]);
  assert.deepEqual(await r.resolve4("PANEL.mc.example.com"), ["9.8.7.6"]);
  const srv = await r.resolveSrv("_minecraft._tcp.play.mc.example.com");
  assert.deepEqual([srv[0].port, srv[0].name], [25570, "play.mc.example.com"]);
  assert.deepEqual(await r.resolveNs("mc.example.com"), ["ns1.example.com"]);
  assert.equal((await r.resolveSoa("mc.example.com")).nsname, "ns1.example.com");
  assert.deepEqual(await r.resolveTxt("mc.example.com"), [["hello"]]);
  assert.deepEqual((await r.resolveMx("mc.example.com"))[0], { exchange: "mail.example.net", priority: 10 });
  assert.deepEqual(await r.resolve4("www.mc.example.com").catch((e) => e.code), ["9.8.7.6"] , "CNAME chased to the A");
  await assert.rejects(r.resolve4("nothing.mc.example.com"), (e) => e.code === "ENOTFOUND");
  await assert.rejects(r.resolve4("other.example.org"), (e) => e.code === "EREFUSED" || e.code === "ECONNREFUSED" || e.code === "ESERVFAIL", "outside our zones: refused");
  await server.stop();
  assert.equal(server.listening(), false);
});

test("API: needs admin, validates, saves zones and shows registrar steps", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "ns-"));
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)");
  ins.run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  ins.run("op", hashPassword("pw-operator-123"), "operator", Date.now());
  process.env.CONSOLE_PUBLIC_IP = "9.8.7.6";
  const app = buildApp({ db, services: createServices({ db, dataDir }), dataDir, nsOptions: { server: { port: 0, address: "127.0.0.1" }, routes: { run: async () => ({ code: 0, stdout: "", stderr: "" }), resolverFor: () => ({ resolveNs: async () => ["ns1.example.com"], resolve4: async () => ["9.8.7.6"] }) } } });
  const login = async (u, p) => { const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } }); return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`; };
  const boss = await login("boss", "pw-admin-123"), op = await login("op", "pw-operator-123");
  const call = (c, m, u, p) => app.inject({ method: m, url: u, headers: { cookie: c }, payload: p });
  assert.equal((await call(op, "GET", "/api/ns")).statusCode, 403);
  assert.equal((await call(boss, "PUT", "/api/ns", { zones: ["bad zone"] })).statusCode, 400);
  const on = await call(boss, "PUT", "/api/ns", { enabled: true, zones: ["play.example.com"] });
  assert.equal(on.statusCode, 200);
  const j = on.json();
  assert.equal(j.listening, true);
  assert.equal(j.zones[0].kind, "records");
  assert.equal(j.zones[0].records[0].value, "ns1.example.com");
  const chk = (await call(boss, "GET", "/api/ns/check")).json();
  assert.equal(chk.zones[0].delegated, true);
  const off = (await call(boss, "PUT", "/api/ns", { enabled: false })).json();
  assert.equal(off.listening, false);
  delete process.env.CONSOLE_PUBLIC_IP;
  await app.close();
});
