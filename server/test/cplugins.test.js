import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { verifySignature } from "../plugins/discord-bot/index.js";
import { computeBoard } from "../src/leaderboards.js";

function setup(pluginExtra = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "cp-"));
  const root = path.join(dataDir, "mc");
  mkdirSync(path.join(root, "world", "stats"), { recursive: true });
  writeFileSync(path.join(root, "server.properties"), "server-port=25565\n");
  writeFileSync(path.join(root, "usercache.json"), JSON.stringify([{ name: "Alex", uuid: "11111111-1111-1111-1111-111111111111" }, { name: "Sam", uuid: "22222222-2222-2222-2222-222222222222" }]));
  writeFileSync(path.join(root, "world", "stats", "11111111-1111-1111-1111-111111111111.json"), JSON.stringify({ stats: { "minecraft:custom": { "minecraft:play_time": 144000, "minecraft:deaths": 3 }, "minecraft:mined": { "minecraft:stone": 10, "minecraft:dirt": 5 } } }));
  writeFileSync(path.join(root, "world", "stats", "22222222-2222-2222-2222-222222222222.json"), JSON.stringify({ stats: { "minecraft:custom": { "minecraft:play_time": 72000, "minecraft:deaths": 9 } } }));
  const db = openDb(":memory:");
  const ins = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)");
  ins.run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  ins.run("op", hashPassword("pw-operator-123"), "operator", Date.now());
  db.prepare("INSERT INTO servers (id, name, type, target) VALUES (?, ?, 'tmux', ?)").run("s1", "S1", JSON.stringify({ session: "mc-s1", startCommand: "java -Xms1024M -Xmx1024M -jar server.jar nogui", cwd: root, stopCommand: "stop", filesRoot: root }));
  const services = createServices({ db, dataDir });
  let live = { online: true, players: { online: 2, max: 20, names: ["Alex", "Sam"] }, level: "world", version: "1.21", address: "play.x", motd: "hi" };
  services.mc.liveStatus = async () => live;
  const ran = [];
  services.runtime.perform = async (s, a, who, cmd) => { ran.push(cmd); return {}; };
  const app = buildApp({ db, services, dataDir, pluginOptions: { pollMs: 3_600_000, ...pluginExtra } });
  return { app, db, services, ran, setLive: (x) => (live = x), dataDir };
}
const login = async (app, u, p) => { const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } }); return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`; };

test("leaderboards read Minecraft's own stats files", async () => {
  const { dataDir } = setup();
  const t = await computeBoard(path.join(dataDir, "mc"), "world", "playtime");
  assert.deepEqual(t.rows.map((r) => [r.name, r.display]), [["Alex", "2.0 h"], ["Sam", "1.0 h"]]);
  assert.equal((await computeBoard(path.join(dataDir, "mc"), "world", "deaths", { exclude: ["sam"] })).rows.length, 1);
  assert.equal(await computeBoard(path.join(dataDir, "mc"), "world", "nope"), null);
});

test("plugins: admin only, enable/disable, secrets never echoed, public API with key + CORS", async () => {
  const { app } = setup();
  await app.ready();
  const boss = await login(app, "boss", "pw-admin-123"), op = await login(app, "op", "pw-operator-123");
  const call = (c, m, u, p) => app.inject({ method: m, url: u, headers: c ? { cookie: c } : {}, payload: p });
  assert.equal((await call(op, "GET", "/api/cplugins")).statusCode, 403);
  const list = (await call(boss, "GET", "/api/cplugins")).json().plugins;
  assert.deepEqual(list.map((p) => p.id).sort(), ["announcer", "discord-bot", "leaderboards", "public-api", "themes"]);
  assert.equal((await call(null, "GET", "/x/public-api/v1/status")).statusCode, 404, "off until enabled");

  const on = await call(boss, "PUT", "/api/cplugins/public-api", { enabled: true, settings: { apiKey: "sekrit-key", origin: "https://shop.example.com" } });
  assert.equal(on.json().status, "running");
  assert.ok(!JSON.stringify(on.json()).includes("sekrit-key"));
  assert.equal((await call(null, "GET", "/x/public-api/v1/status")).statusCode, 401);
  const ok = await app.inject({ method: "GET", url: "/x/public-api/v1/status", headers: { "x-api-key": "sekrit-key" } });
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json().players, { online: 2, max: 20 });
  assert.equal(ok.headers["access-control-allow-origin"], "https://shop.example.com");
  const lb = await app.inject({ method: "GET", url: "/x/public-api/v1/leaderboard/playtime?limit=1&key=sekrit-key" });
  assert.deepEqual(lb.json().rows.map((r) => r.name), ["Alex"]);
  assert.equal((await app.inject({ method: "GET", url: "/x/public-api/v1/players?key=sekrit-key" })).json().players.length, 2);
  assert.equal((await call(boss, "PUT", "/api/cplugins/public-api", { settings: { origin: "x".repeat(600) } })).statusCode, 400);
  await call(boss, "PUT", "/api/cplugins/public-api", { enabled: false });
  assert.equal((await app.inject({ method: "GET", url: "/x/public-api/v1/status?key=sekrit-key" })).statusCode, 404);
});

test("leaderboards page, themes css, announcer", async () => {
  const { app, ran } = setup();
  await app.ready();
  const boss = await login(app, "boss", "pw-admin-123");
  const call = (m, u, p) => app.inject({ method: m, url: u, headers: { cookie: boss }, payload: p });
  await call("PUT", "/api/cplugins/leaderboards", { enabled: true });
  const page = await app.inject({ method: "GET", url: "/x/leaderboards/" });
  assert.match(page.body, /board\.js/);
  assert.match((await app.inject({ method: "GET", url: "/x/leaderboards/board/deaths" })).json().rows[0].name, /Sam/);
  await call("PUT", "/api/cplugins/themes", { enabled: true, settings: { preset: "ocean" } });
  const css = await app.inject({ method: "GET", url: "/api/plugins.css" });
  assert.match(css.body, /--accent:#38bdf8/);
  assert.equal((await call("PUT", "/api/cplugins/themes", { settings: { preset: "nope" } })).statusCode, 400);
  const a = await call("PUT", "/api/cplugins/announcer", { enabled: true, settings: { everyMin: 1, messages: "Hello there\nSecond" } });
  assert.equal(a.json().status, "running");
  void ran;
});

test("discord: signature check is real, events post to the webhook", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const hex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const body = JSON.stringify({ type: 1 });
  const sig = sign(null, Buffer.from("123" + body), privateKey).toString("hex");
  assert.equal(verifySignature(hex, sig, "123", body), true);
  assert.equal(verifySignature(hex, sig, "124", body), false);
  assert.equal(verifySignature(hex, "00".repeat(64), "123", body), false);

  const { app, setLive } = setup();
  await app.ready();
  const boss = await login(app, "boss", "pw-admin-123");
  const posts = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { if (String(url).includes("discord.com")) { posts.push(JSON.parse(init.body).content); return new Response("", { status: 204 }); } return realFetch(url, init); };
  try {
    const call = (m, u, p) => app.inject({ method: m, url: u, headers: { cookie: boss }, payload: p });
    assert.equal((await call("PUT", "/api/cplugins/discord-bot", { enabled: true, settings: { webhookUrl: "https://discord.com/api/webhooks/123456/abc-DEF_1", publicKey: hex } })).json().status, "running");
    const ping = await app.inject({ method: "POST", url: "/x/discord-bot/interactions", headers: { "content-type": "application/json", "x-signature-ed25519": sig, "x-signature-timestamp": "123" }, payload: body });
    assert.equal(ping.statusCode, 200);
    assert.deepEqual(ping.json(), { type: 1 });
    const bad = await app.inject({ method: "POST", url: "/x/discord-bot/interactions", headers: { "content-type": "application/json", "x-signature-ed25519": sig, "x-signature-timestamp": "999" }, payload: body });
    assert.equal(bad.statusCode, 401);
    const cmdBody = JSON.stringify({ type: 2, data: { name: "players" } });
    const cs = sign(null, Buffer.from("5" + cmdBody), privateKey).toString("hex");
    const cmd = await app.inject({ method: "POST", url: "/x/discord-bot/interactions", headers: { "content-type": "application/json", "x-signature-ed25519": cs, "x-signature-timestamp": "5" }, payload: cmdBody });
    assert.match(cmd.json().data.content, /Alex, Sam/);
    // join/leave events come from comparing who is online between checks
    await app.pluginHost.poll(); // baseline: Alex and Sam are online
    posts.length = 0;
    setLive({ online: true, players: { online: 2, max: 20, names: ["Alex", "Kim"] }, level: "world" });
    await app.pluginHost.poll();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(posts.some((x) => /Kim.*joined/.test(x)) && posts.some((x) => /Sam.*left/.test(x)), posts.join(" | "));
    posts.length = 0;
    setLive({ online: false });
    await app.pluginHost.poll();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(posts.some((x) => /offline/.test(x)));
  } finally { globalThis.fetch = realFetch; }
});

test("describe-it builder: needs Claude Code, drafts to its own folder, install is explicit and starts OFF", async () => {
  const t0 = setup();
  await t0.app.ready();
  const b0 = await login(t0.app, "boss", "pw-admin-123");
  const call0 = (m, u, p) => t0.app.inject({ method: m, url: u, headers: { cookie: b0 }, payload: p });
  assert.equal((await call0("POST", "/api/cplugins/build", { prompt: "too short" })).statusCode, 400);
  assert.equal((await call0("POST", "/api/cplugins/build", { prompt: "Show a welcome title to every new player" })).statusCode, 400, "Claude Code isn't enabled yet");

  const dir = mkdtempSync(path.join(os.tmpdir(), "fc-"));
  const bin = path.join(dir, "fake-claude");
  writeFileSync(bin, `#!/bin/sh\nid=$(basename "$PWD")\nprintf '{"id":"%s","name":"Welcome","version":"1.0.0","description":"Greets players"}' "$id" > manifest.json\nprintf 'export default function (ctx) { ctx.log("hi"); }' > index.js\n`, { mode: 0o755 });
  const { app } = setup({ claude: { status: async () => ({ enabled: true, installed: true }) }, builder: { claudeBin: bin } });
  await app.ready();
  const boss = await login(app, "boss", "pw-admin-123");
  const call = (m, u, p) => app.inject({ method: m, url: u, headers: { cookie: boss }, payload: p });
  const started = await call("POST", "/api/cplugins/build", { prompt: "Show a welcome title to every new player" });
  assert.equal(started.statusCode, 200);
  let job;
  for (let i = 0; i < 60; i++) { job = (await call("GET", `/api/jobs/${started.json().jobId}`)).json(); if (job.status !== "running") break; await new Promise((r) => setTimeout(r, 100)); }
  assert.equal(job.status, "done", job.error ?? job.log);
  const drafts = (await call("GET", "/api/cplugins/drafts")).json().drafts;
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].ready, true);
  const files = (await call("GET", `/api/cplugins/drafts/${drafts[0].id}`)).json().files;
  assert.match(files["index.js"], /export default/);
  assert.equal((await call("POST", "/api/cplugins/drafts/..%2Fx/install", {})).statusCode, 404);
  const inst = await call("POST", `/api/cplugins/drafts/${drafts[0].id}/install`, {});
  assert.equal(inst.statusCode, 200);
  const p = (await call("GET", "/api/cplugins")).json().plugins.find((x) => x.id === inst.json().id);
  assert.equal(p.enabled, false, "installed but OFF until you switch it on");
  assert.equal(p.builtin, false);
  assert.equal((await call("PUT", `/api/cplugins/${p.id}`, { enabled: true })).json().status, "running");
});
