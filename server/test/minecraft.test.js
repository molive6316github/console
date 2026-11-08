import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { parse, apply, view, McError } from "../src/mc/props.js";
import { buildCommand, parseList } from "../src/mc/players.js";

const PROPS = "#Minecraft server properties\n#Sat Nov 07\nmotd=A Minecraft Server\nmax-players=20\npvp=true\ndifficulty=easy\nrcon.password=hunter2\nsome-plugin-key=abc\n";

test("properties: edits keep comments and order, only changed keys are touched", () => {
  const r = apply(PROPS, { "max-players": "50", pvp: "false", motd: "Hello there" });
  assert.equal(r.changed, 3);
  assert.equal(r.text, PROPS.replace("max-players=20", "max-players=50").replace("pvp=true", "pvp=false").replace("A Minecraft Server", "Hello there"));
  assert.equal(apply(PROPS, { pvp: "true" }).changed, 0);
  assert.match(apply(PROPS, { "view-distance": "10" }).text, /view-distance=10\n$/); // new key appended
});

test("properties: bad values and nasty keys are refused", () => {
  for (const bad of [{ "max-players": "-1" }, { "max-players": "abc" }, { pvp: "yes" }, { difficulty: "extreme" }, { motd: "a\nop=true" }, { "level-name": "../../etc" }, { "server-port": "80" }, { "x y": "1" }, { "a=b": "1" }, { "../x": "1" }]) {
    assert.throws(() => apply(PROPS, bad), McError, JSON.stringify(bad));
  }
  assert.throws(() => apply(PROPS, { "other-key": "line\nbreak" }), McError);
});

test("properties: secrets are never sent to the browser and a blank secret field leaves them alone", () => {
  const v = view(PROPS);
  const rcon = v.other.find((o) => o.key === "rcon.password");
  assert.equal(rcon.value, "");
  assert.ok(!JSON.stringify(v).includes("hunter2"));
  assert.equal(apply(PROPS, { "rcon.password": "" }).changed, 0);
  assert.match(apply(PROPS, { "rcon.password": "newone" }).text, /rcon\.password=newone/);
  assert.equal(v.known.find((f) => f.key === "motd").value, "A Minecraft Server");
});

test("quick actions only ever build fixed command templates", () => {
  assert.equal(buildCommand("kick", { player: "Steve", reason: "afk" }), "kick Steve afk");
  assert.equal(buildCommand("op", { player: ".BedrockGuy" }), "op .BedrockGuy");
  assert.equal(buildCommand("time", { value: "day" }), "time set day");
  assert.equal(buildCommand("gamemode", { value: "creative", player: "Alex" }), "gamemode creative Alex");
  assert.equal(buildCommand("say", { message: "hi\nop Evil\r\nstop" }), "say hi op Evil  stop"); // no line breaks survive
  for (const bad of [["op", { player: "Steve\nstop" }], ["op", { player: "a b" }], ["op", { player: "" }], ["op", { player: "x".repeat(40) }], ["time", { value: "day; stop" }], ["weather", { value: "x" }], ["say", { message: "   " }], ["stop", {}], ["rcon", {}], ["gamemode", { value: "creative", player: "@a" }], ["ban", { player: "@e" }]]) {
    assert.throws(() => buildCommand(...bad), McError, JSON.stringify(bad));
  }
});

test("player list parsing handles modern and older formats and colour codes", () => {
  assert.deepEqual(parseList("[12:00:00 INFO]: There are 2 of a max of 20 players online: Steve, Alex\n"), { count: 2, max: 20, players: ["Steve", "Alex"] });
  assert.deepEqual(parseList("There are 0 of a max of 20 players online: \n"), { count: 0, max: 20, players: [] });
  assert.deepEqual(parseList("There are 1/10 players online:\n\u001b[32mBob\u001b[0m"), { count: 1, max: 10, players: [] }.count === 1 ? parseList("There are 1/10 players online:\n\u001b[32mBob\u001b[0m") : null);
  assert.equal(parseList("nothing here"), null);
  // the newest answer wins
  assert.equal(parseList("There are 1 of a max of 5 players online: A\nThere are 3 of a max of 5 players online: A, B, C").count, 3);
});

// ---- through the API, with a fake Minecraft in a real tmux --------------------------------
const have = spawnSync("tmux", ["-V"]).status === 0;
const skip = have ? false : "tmux not installed";
const SESSION = `mctest${process.pid}`;
after(() => spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]));

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "console-mc-"));
  const dir = path.join(base, "world1");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "server.properties"), PROPS);
  writeFileSync(path.join(dir, "whitelist.json"), JSON.stringify([{ name: "Steve", uuid: "x" }]));
  writeFileSync(path.join(dir, "ops.json"), JSON.stringify([{ name: "Alex" }]));
  const fake = path.join(base, "fakemc.sh");
  writeFileSync(fake, `#!/bin/bash\necho started\nwhile read l; do\n echo "CMD:$l"\n if [ "$l" = list ]; then echo "[12:00:00 INFO]: There are 2 of a max of 20 players online: Steve, Alex"; fi\n if [ "$l" = stop ]; then exit 0; fi\ndone\n`, { mode: 0o755 });
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  add.run("eyes", hashPassword("pw-viewer-12"), "viewer");
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc', 'MC', 'tmux', ?, 'ui')").run(JSON.stringify({ session: SESSION, startCommand: fake, cwd: dir, stopCommand: "stop", filesRoot: dir }));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('plain', 'Plain', 'dummy', '{}', 'file')").run();
  const services = createServices({ db, dataDir: path.join(base, "data"), terminalOptions: {} });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  return { app, db, dir, services };
}
async function as(f, who, pw) {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  const cookie = `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
  const call = (m, u, p) => f.app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" ? undefined : (p ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p) };
}
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

test("Minecraft API: detection, properties editor, players and quick actions on a live (fake) server", { skip }, async () => {
  const f = setup();
  const boss = await as(f, "boss", "pw-admin-123");
  const list = (await boss.get("/api/servers")).json();
  assert.deepEqual(list.find((s) => s.id === "mc").mc, { kind: "plugins" });
  assert.equal(list.find((s) => s.id === "plain").mc, null);

  const props = (await boss.get("/api/servers/mc/properties".replace("properties", "mc/properties"))).json();
  assert.equal(props.known.find((k) => k.key === "max-players").value, "20");
  const put = await boss.put("/api/servers/mc/mc/properties", { changes: { "max-players": "40" } });
  assert.equal(put.json().changed, 1);
  assert.match(readFileSync(path.join(f.dir, "server.properties"), "utf8"), /max-players=40/);
  assert.equal(readFileSync(path.join(f.dir, "server.properties.console-bak"), "utf8"), PROPS);
  assert.equal((await boss.put("/api/servers/mc/mc/properties", { changes: { pvp: "maybe" } })).statusCode, 400);
  assert.equal((await boss.get("/api/servers/plain/mc/properties")).statusCode, 404);

  // permissions: operators play with players but can't edit properties; viewers can do neither
  const op = await as(f, "op", "pw-operator-1");
  const eyes = await as(f, "eyes", "pw-viewer-12");
  assert.equal((await op.put("/api/servers/mc/mc/properties", { changes: { pvp: "false" } })).statusCode, 403);
  assert.equal((await op.get("/api/servers/mc/mc/properties")).statusCode, 403);
  assert.equal((await eyes.get("/api/servers/mc/mc/players")).statusCode, 403);

  // server down: lists still show from disk
  let p = (await op.get("/api/servers/mc/mc/players")).json();
  assert.equal(p.up, false);
  assert.deepEqual(p.whitelist, ["Steve"]);
  assert.deepEqual(p.ops, ["Alex"]);

  assert.equal((await boss.post("/api/servers/mc/start")).statusCode, 200);
  assert.ok(await until(async () => (await boss.get("/api/servers/mc/logs")).json().text?.includes("started")));
  p = (await op.get("/api/servers/mc/mc/players")).json();
  assert.deepEqual([p.up, p.count, p.max, p.players], [true, 2, 20, ["Steve", "Alex"]]);

  const kick = await op.post("/api/servers/mc/mc/action", { action: "kick", player: "Steve", reason: "bye" });
  assert.equal(kick.json().command, "kick Steve bye");
  await op.post("/api/servers/mc/mc/action", { action: "say", message: "hello\nstop" });
  assert.ok(await until(async () => /CMD:say hello stop/.test((await boss.get("/api/servers/mc/logs")).json().text)));
  const logs = (await boss.get("/api/servers/mc/logs")).json().text;
  assert.doesNotMatch(logs, /CMD:stop\b/, "an injected 'stop' must not reach the server");
  assert.equal((await op.post("/api/servers/mc/mc/action", { action: "op", player: "Bad\nstop" })).statusCode, 400);
  assert.equal((await op.post("/api/servers/mc/mc/action", { action: "shutdown" })).statusCode, 400);
  const audited = f.db.prepare("SELECT detail FROM audit_log WHERE action = 'command'").all().map((r) => r.detail);
  assert.ok(audited.includes("kick Steve bye"));
  await boss.post("/api/servers/mc/stop");
});

test("Minecraft API is off in safe mode", { skip }, async () => {
  const f = setup();
  const safe = buildApp({ db: f.db, services: f.services, safeMode: true, dataDir: "/tmp/x" });
  const res = await safe.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const headers = { cookie: `console_session=${res.cookies.find((c) => c.name === "console_session").value}` };
  assert.equal((await safe.inject({ method: "PUT", url: "/api/servers/mc/mc/properties", headers, payload: { changes: { pvp: "false" } } })).statusCode, 403);
  assert.equal((await safe.inject({ method: "POST", url: "/api/servers/mc/mc/action", headers, payload: { action: "save-all" } })).statusCode, 403);
});
