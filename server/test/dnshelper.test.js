import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { wantedRecords, createChecker, createProvider, validIp4 } from "../src/dns.js";

test("wanted records: A always, SRV only for a non-default Minecraft port; bad input refused", () => {
  assert.deepEqual(wantedRecords({ host: "play.example.com", ip: "1.2.3.4", minecraft: true }).map((r) => r.type), ["A"]);
  const r = wantedRecords({ host: "Play.Example.com", ip: "1.2.3.4", port: 25570, minecraft: true });
  assert.deepEqual(r.map((x) => x.type), ["A", "SRV"]);
  assert.equal(r[1].name, "_minecraft._tcp.play.example.com");
  assert.equal(r[1].value, "0 5 25570 play.example.com");
  assert.throws(() => wantedRecords({ host: "nope", ip: "1.2.3.4" }), /domain name/);
  assert.throws(() => wantedRecords({ host: "a.example.com", ip: "" }), /public IP/);
  assert.equal(validIp4("999.1.1.1"), false);
});

test("checker: ok, wrong (shows what it found), missing", async () => {
  const resolver = {
    resolve4: async (n) => { if (n === "good.example.com") return ["1.2.3.4"]; if (n === "vercel.example.com") return ["216.198.79.1"]; const e = new Error("x"); e.code = "ENOTFOUND"; throw e; },
    resolveSrv: async () => [{ port: 25570, name: "play.example.com." }],
  };
  const check = createChecker({ resolver });
  assert.equal((await check({ type: "A", name: "good.example.com", value: "1.2.3.4" })).state, "ok");
  const w = await check({ type: "A", name: "vercel.example.com", value: "1.2.3.4" });
  assert.deepEqual([w.state, w.found], ["wrong", "216.198.79.1"]);
  assert.equal((await check({ type: "A", name: "none.example.com", value: "1.2.3.4" })).state, "missing");
  assert.equal((await check({ type: "SRV", name: "_minecraft._tcp.play.example.com", srv: { port: 25570, target: "play.example.com" } })).state, "ok");
});

// A fake Cloudflare + Vercel that remember what they were given.
function fakeApi() {
  const calls = [];
  const records = { cf: [], vc: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push(`${init.method ?? "GET"} ${u.hostname}${u.pathname}${u.search}`);
    const ok = (o, s = 200) => new Response(JSON.stringify(o), { status: s });
    if (!/Bearer good/.test(init.headers?.Authorization ?? "")) return ok({ success: false, errors: [{ message: "Invalid token" }], error: { message: "Invalid token" } }, 403);
    if (u.hostname === "api.cloudflare.com") {
      if (u.pathname.endsWith("/user/tokens/verify")) return ok({ success: true, result: {} });
      if (u.pathname === "/client/v4/zones") return ok({ success: true, result: u.searchParams.get("name") === "example.com" ? [{ id: "Z1", name: "example.com" }] : [] });
      if (u.pathname === "/client/v4/zones/Z1/dns_records" && (init.method ?? "GET") === "GET") return ok({ success: true, result: records.cf.filter((r) => r.type === u.searchParams.get("type") && r.name === u.searchParams.get("name")) });
      if (u.pathname === "/client/v4/zones/Z1/dns_records" && init.method === "POST") { records.cf.push({ id: `r${records.cf.length}`, ...body }); return ok({ success: true, result: {} }); }
    }
    if (u.hostname === "api.vercel.com") {
      if (u.pathname === "/v2/user") return ok({ user: {} });
      if (u.pathname === "/v5/domains/example.com") return ok({ domain: {} });
      if (u.pathname.startsWith("/v5/domains/")) return ok({ error: { message: "not found" } }, 404);
      if (u.pathname === "/v4/domains/example.com/records") return ok({ records: records.vc });
      if (u.pathname === "/v2/domains/example.com/records" && init.method === "POST") { records.vc.push({ id: `v${records.vc.length}`, ...body, value: body.value }); return ok({ uid: "x" }); }
    }
    return ok({ error: { message: `unhandled ${u.pathname}` } }, 404);
  };
  return { fetchImpl, calls, records };
}

test("Cloudflare: creates A and SRV, second run changes nothing, bad token is refused, wrong zone explained", async () => {
  const f = fakeApi();
  const p = createProvider("cloudflare", { token: "good-token-123", fetchImpl: f.fetchImpl });
  await p.verify();
  const a = { type: "A", name: "play.example.com", value: "1.2.3.4" };
  const srv = { type: "SRV", name: "_minecraft._tcp.play.example.com", srv: { priority: 0, weight: 5, port: 25570, target: "play.example.com" } };
  assert.equal(await p.upsert(a), "created");
  assert.equal(await p.upsert(srv), "created");
  assert.deepEqual(f.records.cf.find((r) => r.type === "SRV").data, { priority: 0, weight: 5, port: 25570, target: "play.example.com" });
  assert.equal(f.records.cf.find((r) => r.type === "A").proxied, false, "never proxied, or Minecraft and HTTPS certs break");
  assert.equal(await p.upsert(a), "unchanged");
  await assert.rejects(createProvider("cloudflare", { token: "bad-token-123", fetchImpl: f.fetchImpl }).verify(), /Invalid token/);
  await assert.rejects(p.upsert({ ...a, name: "x.other.org" }), /No Cloudflare zone/);
});

test("Vercel: finds the right domain, creates records relative to it, leaves matching ones alone", async () => {
  const f = fakeApi();
  const p = createProvider("vercel", { token: "good-token-123", fetchImpl: f.fetchImpl });
  await p.verify();
  assert.equal(await p.upsert({ type: "A", name: "panel.example.com", value: "1.2.3.4" }), "created");
  assert.equal(f.records.vc[0].name, "panel", "name is relative to the domain");
  assert.equal(await p.upsert({ type: "A", name: "panel.example.com", value: "1.2.3.4" }), "unchanged");
  await assert.rejects(p.upsert({ type: "A", name: "x.unknown.org", value: "1.2.3.4" }), /isn't a domain on this Vercel account/);
});

test("routes: admin only; token is verified before saving and never sent back; apply writes every needed record", async () => {
  const f = fakeApi();
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('op', ?, 'operator', 1)").run(hashPassword("pw-operator-123"));
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "dns-"));
  writeFileSync(path.join(dir, "server.properties"), "server-port=25570\n");
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','MC','dummy',?,'ui')").run(JSON.stringify({ filesRoot: dir }));
  setSetting(db, "join_domain", "play.example.com");
  const services = createServices({ db, dataDir: path.join(dir, "d") });
  const app = buildApp({ db, services, dnsOptions: { publicIp: () => "9.9.9.9", fetchImpl: f.fetchImpl, check: async () => ({ state: "missing" }), guess: async () => ({ kind: "cloudflare", name: "Cloudflare" }) } });
  const login = async (u, p) => { const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } }); return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`; };
  const boss = await login("boss", "pw-admin-123"), op = await login("op", "pw-operator-123");
  const call = (c, m, u, p) => app.inject({ method: m, url: u, headers: { cookie: c }, payload: p });
  assert.equal((await call(op, "GET", "/api/dns")).statusCode, 403);
  const info = (await call(boss, "GET", "/api/dns")).json();
  assert.equal(info.ip, "9.9.9.9");
  assert.deepEqual(info.hosts[0].records.map((r) => r.type), ["A", "SRV"]);
  assert.equal((await call(boss, "PUT", "/api/dns/provider", { kind: "cloudflare", token: "bad-token-123" })).statusCode, 400);
  assert.equal((await call(boss, "GET", "/api/dns")).json().provider, null, "a bad token is never saved");
  const ok = await call(boss, "PUT", "/api/dns/provider", { kind: "cloudflare", token: "good-token-123" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(JSON.stringify(ok.json()).includes("good-token"), false, "token never comes back");
  assert.equal((await call(boss, "GET", "/api/dns")).json().provider.tokenTail, "-123");
  const res = (await call(boss, "POST", "/api/dns/apply", {})).json().results;
  assert.deepEqual(res.map((r) => r.action), ["created", "created"]);
  assert.equal((await call(boss, "GET", "/api/dns/check")).json().allGood, false);
});
