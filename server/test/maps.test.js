import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, createWriteStream, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import yazl from "yazl";
import { openDb, getServer } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import * as M from "../src/mc/maps.js";

function tmp() { return mkdtempSync(path.join(tmpdir(), "console-maps-")); }
function server(extra = {}) {
  const root = tmp();
  mkdirSync(path.join(root, "world"), { recursive: true });
  writeFileSync(path.join(root, "server.properties"), "motd=hi\nlevel-name=world\n");
  writeFileSync(path.join(root, "world", "level.dat"), "MAIN");
  for (const [f, v] of Object.entries(extra)) { mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); writeFileSync(path.join(root, f), v); }
  return root;
}
async function zipFile(files, { symlink } = {}) {
  const z = new yazl.ZipFile();
  for (const [n, v] of Object.entries(files)) z.addBuffer(Buffer.from(v), n, symlink === n ? { mode: 0o120777 } : {});
  z.end();
  const file = path.join(tmp(), "x.zip");
  await pipeline(z.outputStream, createWriteStream(file));
  return file;
}
const zipBytes = (files) => zipFile(files).then((f) => readFileSync(f));

test("import: strips the wrapper folder, drops uid.dat, lists the world", async () => {
  const root = server();
  const file = await zipFile({ "MyMap/level.dat": "L", "MyMap/region/r.0.0.mca": "R", "MyMap/uid.dat": "U", "__MACOSX/MyMap/._level.dat": "junk" });
  const r = await M.importZip({ root, file, name: "adventure" });
  assert.equal(r.name, "adventure");
  assert.equal(readFileSync(path.join(root, "adventure", "level.dat"), "utf8"), "L");
  assert.ok(existsSync(path.join(root, "adventure", "region", "r.0.0.mca")));
  assert.ok(!existsSync(path.join(root, "adventure", "uid.dat")));
  assert.ok(!existsSync(path.join(root, "adventure", "__MACOSX")));
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".import")), [], "no temp folder left");
  const list = await M.listWorlds(root);
  assert.deepEqual(list.worlds.map((w) => [w.name, w.main]), [["adventure", false], ["world", true]]);
});

test("import refuses: no level.dat, existing name, bad names, links, zip-slip, oversize", async () => {
  const root = server();
  await assert.rejects(M.importZip({ root, file: await zipFile({ "a.txt": "x" }), name: "w2" }), /level\.dat/);
  await assert.rejects(M.importZip({ root, file: await zipFile({ "level.dat": "x" }), name: "world" }), /already/);
  for (const bad of ["../evil", "a/b", "", ".hid", "plugins", "x".repeat(60)]) {
    await assert.rejects(M.importZip({ root, file: await zipFile({ "level.dat": "x" }), name: bad }), /name|reserved/i, bad);
  }
  await assert.rejects(M.importZip({ root, file: await zipFile({ "level.dat": "x", "link": "/etc/passwd" }, { symlink: "link" }), name: "w3" }), /symbolic/);
  // forge a zip-slip entry: same-length name patched in the bytes
  const buf = await zipBytes({ "aa/level.dat": "x", "aa/pwned.txt": "x" });
  const evil = Buffer.from(buf.toString("latin1").split("aa/pwned.txt").join("../pwned.txt"), "latin1");
  const ef = path.join(tmp(), "evil.zip");
  writeFileSync(ef, evil);
  await assert.rejects(M.importZip({ root, file: ef, name: "w4" }), /unsafe|damaged/);
  assert.ok(!existsSync(path.join(path.dirname(root), "pwned.txt")));
  assert.ok(!existsSync(path.join(root, "w4")));
  await assert.rejects(M.importZip({ root, file: await zipFile({ "level.dat": "x".repeat(5000) }), name: "w5", maxBytes: 100 }), /too large/);
  assert.ok(!existsSync(path.join(root, "w5")));
  await assert.rejects(M.importZip({ root, file: path.join(tmp(), "nope.zip"), name: "w6" }), /readable|zip/);
  assert.deepEqual(readdirSync(root).filter((n) => n.startsWith(".import")), []);
});

test("export then import round-trips a world with its nether", async () => {
  const root = server({ "world_nether/DIM-1/region/r.0.0.mca": "N", "world/region/r.0.0.mca": "R", "world/session.lock": "lock" });
  const { stream, filename } = await M.exportZip({ root, name: "world" });
  assert.equal(filename, "world.zip");
  const file = path.join(tmp(), "out.zip");
  await pipeline(stream, createWriteStream(file));
  const root2 = server();
  // exported layout is <name>/..., import finds level.dat under world/
  const r = await M.importZip({ root: root2, file, name: "copy" });
  assert.equal(r.name, "copy");
  assert.equal(readFileSync(path.join(root2, "copy", "region", "r.0.0.mca"), "utf8"), "R");
  assert.ok(!existsSync(path.join(root2, "copy", "session.lock")));
  await assert.rejects(M.exportZip({ root, name: "nothere" }), /No such world/);
  await assert.rejects(M.exportZip({ root, name: "../x" }), /No such world/);
});

test("worlds list groups nether/end under their world and ignores plugin folders", async () => {
  const root = server({ "world_nether/level.dat": "n", "world_the_end/level.dat": "e", "lobby/region/r.mca": "x", "plugins/Foo/level.dat": "no", "old-worlds/x/level.dat": "no" });
  const { worlds } = await M.listWorlds(root);
  assert.deepEqual(worlds.map((w) => w.name), ["lobby", "world"]);
  assert.deepEqual(worlds.find((w) => w.name === "world").dims, ["world_nether", "world_the_end"]);
});

test("archive moves a world aside (never the main one); set-main edits level-name", async () => {
  const root = server({ "lobby/level.dat": "L", "lobby_nether/level.dat": "n" });
  await assert.rejects(M.archiveWorld({ root, name: "world" }), /main world/);
  await assert.rejects(M.archiveWorld({ root, name: "../world" }), /Bad world name/);
  const r = await M.archiveWorld({ root, name: "lobby" });
  assert.ok(existsSync(path.join(root, r.movedTo, "lobby", "level.dat")));
  assert.ok(existsSync(path.join(root, r.movedTo, "lobby_nether")));
  assert.ok(!existsSync(path.join(root, "lobby")));
  mkdirSync(path.join(root, "arena"));
  writeFileSync(path.join(root, "arena", "level.dat"), "A");
  const s = await M.setMainWorld({ root, name: "arena" });
  assert.deepEqual([s.previous, s.main], ["world", "arena"]);
  assert.match(readFileSync(path.join(root, "server.properties"), "utf8"), /level-name=arena/);
  assert.match(readFileSync(path.join(root, "server.properties"), "utf8"), /motd=hi/);
});

test("private addresses are refused; links go through the pinned fetch only when public", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.5", "172.16.0.1", "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "224.0.0.1"]) assert.ok(M.isPrivateAddress(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700:4700::1111"]) assert.ok(!M.isPrivateAddress(ip), ip);
  const root = server();
  for (const url of ["http://127.0.0.1:9/w.zip", "http://localhost/w.zip", "http://[::1]/w.zip", "http://169.254.169.254/latest", "ftp://example.com/w.zip", "https://user:pw@example.com/w.zip", "not a url", "http://10.0.0.1/w.zip"]) {
    await assert.rejects(M.importFromUrl({ root, url, name: "dl", tmpDir: tmp() }), /private|valid|http|login|find/i, url);
  }
  assert.ok(!existsSync(path.join(root, "dl")));
  // with an injected getter the rest of the pipeline works and cleans up
  const bytes = await zipBytes({ "level.dat": "FROM-LINK", "region/r.0.0.mca": "x" });
  const td = tmp();
  const r = await M.importFromUrl({ root, url: "https://example.com/w.zip", name: "dl", tmpDir: td, get: async () => Readable.from([bytes]) });
  assert.equal(r.name, "dl");
  assert.equal(readFileSync(path.join(root, "dl", "level.dat"), "utf8"), "FROM-LINK");
  assert.deepEqual(readdirSync(td), [], "downloaded zip removed");
  await assert.rejects(M.importFromUrl({ root, url: "https://example.com/w.zip", name: "bad", tmpDir: td, get: async () => Readable.from([Buffer.from("not a zip")]) }), /zip/);
  assert.deepEqual(readdirSync(td), []);
});

test("lobby plan matches the installed Multiverse; only safe commands are accepted", () => {
  const v5 = M.lobbyPlan({ name: "lobby", exists: false, mv: { major: 5 } });
  assert.equal(v5[0].cmd, "mv create lobby normal -t flat");
  assert.ok(v5.some((s) => s.cmd === "mv modify lobby set pvp false"));
  const v4 = M.lobbyPlan({ name: "hub", exists: true, mv: { major: 4 } });
  assert.equal(v4[0].cmd, "mv import hub normal");
  assert.ok(v4.some((s) => s.cmd === "mv modify set pvp false hub"));
  assert.throws(() => M.lobbyPlan({ name: "a b;c", exists: false }), /Lobby names/);
  for (const s of [...v5, ...v4]) assert.match(s.cmd, M.SAFE_COMMAND, s.cmd);
  for (const bad of ["op me", "stop", "mv create x; stop", "mv\nstop", "say hi", "execute run stop", "mv " + "a".repeat(200)]) assert.doesNotMatch(bad, M.SAFE_COMMAND, bad);
  assert.deepEqual(M.newLines("a\nb\nc", "b\nc\nd\ne"), ["d", "e"]);
  assert.deepEqual(M.newLines("", "x\ny"), ["x", "y"]);
  assert.equal(M.envOf("w_nether"), "nether");
  assert.equal(M.envOf("w_the_end"), "the_end");
  assert.equal(M.envOf("w"), "normal");
});

test("multiverse detection reads the plugin jar name", () => {
  const root = server({ "plugins/Multiverse-Core-5.0.1.jar": "x" });
  assert.deepEqual(M.multiverseInfo(root), { installed: true, version: "5.0", major: 5 });
  assert.equal(M.multiverseInfo(server()).installed, false);
});

// ---- over HTTP ----
function setup(over = {}) {
  const base = tmp();
  const dir = path.join(base, "srv");
  mkdirSync(path.join(dir, "world"), { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "level-name=world\n");
  writeFileSync(path.join(dir, "world", "level.dat"), "MAIN");
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("view", hashPassword("pw-viewer-123"), "viewer");
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc', 'MC', 'dummy', ?, 'ui')").run(JSON.stringify({ filesRoot: dir }));
  const services = createServices({ db, dataDir: path.join(base, "data"), ...over });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  return { app, dir, base, srv: getServer(db, "mc") };
}
async function login(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  return `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
}

test("HTTP: upload a zip, list, download it back, archive; guards hold", async () => {
  const f = setup();
  const cookie = await login(f);
  const zip = await zipBytes({ "Map/level.dat": "UP", "Map/region/r.0.0.mca": "x" });
  const up = (headers, url = "/api/servers/mc/mc/worlds/upload?name=uploaded") => f.app.inject({ method: "POST", url, headers: { cookie, ...headers }, payload: zip });
  // no custom header = refused (blocks cross-site form posts)
  assert.equal((await up({ "content-type": "application/octet-stream" })).statusCode, 415);
  const ok = await up({ "content-type": "application/octet-stream", "x-console-upload": "1" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(ok.json().name, "uploaded");
  assert.equal(readFileSync(path.join(f.dir, "uploaded", "level.dat"), "utf8"), "UP");
  const dup = await up({ "content-type": "application/octet-stream", "x-console-upload": "1" });
  assert.equal(dup.statusCode, 409);
  const bad = await up({ "content-type": "application/octet-stream", "x-console-upload": "1" }, "/api/servers/mc/mc/worlds/upload?name=..%2Fx");
  assert.equal(bad.statusCode, 400);
  // viewers can't upload
  const vc = await login(f, "view", "pw-viewer-123");
  const vr = await f.app.inject({ method: "POST", url: "/api/servers/mc/mc/worlds/upload?name=v", headers: { cookie: vc, "content-type": "application/octet-stream", "x-console-upload": "1" }, payload: zip });
  assert.equal(vr.statusCode, 403);
  assert.ok(!existsSync(path.join(f.dir, "v")));

  const list = (await f.app.inject({ method: "GET", url: "/api/servers/mc/mc/worlds", headers: { cookie } })).json();
  assert.deepEqual(list.worlds.map((w) => w.name), ["uploaded", "world"]);
  assert.equal(list.main, "world");
  assert.equal(list.multiverse.installed, false);

  const dl = await f.app.inject({ method: "GET", url: "/api/servers/mc/mc/worlds/uploaded/download", headers: { cookie } });
  assert.equal(dl.statusCode, 200);
  assert.match(dl.headers["content-type"], /zip/);
  assert.match(dl.headers["content-disposition"], /uploaded\.zip/);
  assert.equal(dl.rawPayload.subarray(0, 2).toString(), "PK");
  assert.equal((await f.app.inject({ method: "GET", url: "/api/servers/mc/mc/worlds/nope/download", headers: { cookie } })).statusCode, 404);

  const post = (u, p) => f.app.inject({ method: "POST", url: u, headers: { cookie }, payload: p });
  assert.equal((await post("/api/servers/mc/mc/worlds/archive", { name: "uploaded", confirm: "wrong" })).statusCode, 400);
  assert.equal((await post("/api/servers/mc/mc/worlds/archive", { name: "world", confirm: "mc" })).statusCode, 400, "main world is protected");
  const arch = await post("/api/servers/mc/mc/worlds/archive", { name: "uploaded", confirm: "mc" });
  assert.equal(arch.statusCode, 200, arch.body);
  assert.ok(!existsSync(path.join(f.dir, "uploaded")));
  // no multiverse: activating says so; lobby run refuses
  assert.equal((await post("/api/servers/mc/mc/worlds/activate", { name: "world" })).statusCode, 409);
  const plan = (await f.app.inject({ method: "GET", url: "/api/servers/mc/mc/lobby?name=lobby", headers: { cookie } })).json();
  assert.equal(plan.steps[0].cmd, "mv create lobby normal -t flat");
  assert.equal((await post("/api/servers/mc/mc/lobby/run", { commands: ["mv list"] })).statusCode, 409);
});

test("HTTP: import from a link runs as a job and refuses private addresses", async () => {
  const bytes = await zipBytes({ "level.dat": "LINKED" });
  const f = setup({ mcOptions: { worldGet: async (url) => { if (!/example\.com/.test(url)) throw new Error("unexpected"); return Readable.from([bytes]); } } });
  const cookie = await login(f);
  const post = (u, p) => f.app.inject({ method: "POST", url: u, headers: { cookie }, payload: p });
  const r = await post("/api/servers/mc/mc/worlds/import-url", { url: "https://example.com/m.zip", name: "linked" });
  assert.equal(r.statusCode, 200, r.body);
  let job;
  for (let i = 0; i < 100; i++) { job = (await f.app.inject({ method: "GET", url: `/api/jobs/${r.json().jobId}`, headers: { cookie } })).json(); if (job.status !== "running") break; await new Promise((x) => setTimeout(x, 50)); }
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(readFileSync(path.join(f.dir, "linked", "level.dat"), "utf8"), "LINKED");
  const noName = await post("/api/servers/mc/mc/worlds/import-url", { url: "https://example.com/m.zip", name: "../x" });
  assert.equal(noName.statusCode, 400);
});

import { spawnSync } from "node:child_process";
const haveTmux = spawnSync("tmux", ["-V"]).status === 0;
test("HTTP: lobby run sends commands to the live game, reports what it said, and refuses anything else", { skip: haveTmux ? false : "no tmux" }, async () => {
  const SESSION = `maps${process.pid}`;
  const base = tmp();
  const dir = path.join(base, "srv");
  mkdirSync(path.join(dir, "world"), { recursive: true });
  mkdirSync(path.join(dir, "plugins"), { recursive: true });
  writeFileSync(path.join(dir, "plugins", "Multiverse-Core-5.0.0.jar"), "x");
  writeFileSync(path.join(dir, "server.properties"), "level-name=world\n");
  writeFileSync(path.join(dir, "world", "level.dat"), "M");
  const fake = path.join(base, "fake.sh");
  writeFileSync(fake, `#!/bin/bash\necho started\nwhile read l; do\n case "$l" in\n  "mv create lobby normal -t flat") echo "[12:00:00 INFO]: World lobby created";;\n  "mv bogus") echo "[12:00:00 INFO]: Unknown command. Type help";;\n  stop) exit 0;;\n  *) echo "[12:00:00 INFO]: ok $l";;\n esac\ndone\n`, { mode: 0o755 });
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc', 'MC', 'tmux', ?, 'ui')").run(JSON.stringify({ session: SESSION, startCommand: fake, cwd: dir, stopCommand: "stop", filesRoot: dir }));
  const services = createServices({ db, dataDir: path.join(base, "data"), mcOptions: { listWaitMs: 200 } });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  const f = { app };
  try {
    const cookie = await login(f);
    const post = (u, p) => app.inject({ method: "POST", url: u, headers: { cookie }, payload: p });
    assert.equal((await post("/api/servers/mc/mc/lobby/run", { commands: ["mv create lobby normal -t flat"] })).statusCode, 409, "needs a running server");
    const st = await post("/api/servers/mc/start", {});
    assert.equal(st.statusCode, 200, st.body);
    const srv = getServer(db, "mc");
    for (let i = 0; i < 60 && (await services.runtime.status(srv).catch((e) => e.message)) !== "up"; i++) await new Promise((r) => setTimeout(r, 100));
    const r = await post("/api/servers/mc/mc/lobby/run", { commands: ["mv create lobby normal -t flat", "mv bogus", "stop", "mv list; stop"] });
    assert.equal(r.statusCode, 200, r.body);
    const [a, b, c, d] = r.json().results;
    assert.equal(a.ok, true);
    assert.match(a.output, /World lobby created/);
    assert.equal(b.ok, false);
    assert.match(b.output, /Unknown command/);
    assert.equal(c.ok, false); assert.match(c.output, /Refused/);
    assert.equal(d.ok, false); assert.match(d.output, /Refused/);
    assert.equal((await services.runtime.status(srv)), "up", "refused commands never reached the game");
    const act = await post("/api/servers/mc/mc/worlds/activate", { name: "world" });
    assert.equal(act.statusCode, 200, act.body);
    assert.equal(act.json().sent, "mv import world normal");
  } finally {
    spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]);
  }
});
