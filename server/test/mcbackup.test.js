import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { openDb, setSetting, getServer } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { redactText } from "../src/mc/github.js";

const have = spawnSync("tmux", ["-V"]).status === 0;
const SESSION = `mcbk${process.pid}`;
after(() => spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]));
const until = async (fn, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 100)); }
  return null;
};

// Every destructive test works inside a fresh temp folder. Nothing here points at a real path.
function setup({ tmux = false, fetchImpl } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-mcbk-"));
  const dir = path.join(base, "srv");
  mkdirSync(path.join(dir, "world"), { recursive: true });
  mkdirSync(path.join(dir, "world_nether"), { recursive: true });
  mkdirSync(path.join(dir, "plugins", "Essentials"), { recursive: true });
  mkdirSync(path.join(dir, "config"), { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=hi\nlevel-name=world\nrcon.password=hunter2hunter2\n");
  writeFileSync(path.join(dir, "world", "level.dat"), "ORIGINAL-WORLD");
  writeFileSync(path.join(dir, "world_nether", "n.dat"), "NETHER");
  writeFileSync(path.join(dir, "plugins", "Essentials", "config.yml"), "spawn: true\napi-key: abcd1234\ndiscord:\n  token: \"xyz\"\n");
  writeFileSync(path.join(dir, "plugins", "Big.jar"), "jar-bytes");
  writeFileSync(path.join(dir, "config", "paper.yml"), "x: 1\n");
  const events = path.join(base, "events.log");
  const fake = path.join(base, "fakemc.sh");
  writeFileSync(fake, `#!/bin/bash\necho started\nwhile read l; do\n echo "CMD:$l"\n if [ "$l" = save-off ]; then echo off >> ${events}; fi\n if [ "$l" = save-on ]; then echo on >> ${events}; fi\n if [ "$l" = "save-all flush" ]; then echo "[12:00:00 INFO]: Saved the game"; fi\n if [ "$l" = stop ]; then exit 0; fi\ndone\n`, { mode: 0o755 });
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  const target = tmux ? { session: SESSION, startCommand: fake, cwd: dir, stopCommand: "stop", filesRoot: dir } : { filesRoot: dir };
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc', 'MC', ?, ?, 'ui')").run(tmux ? "tmux" : "dummy", JSON.stringify(target));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('plain', 'Plain', 'dummy', '{}', 'ui')").run();
  setSetting(db, "github_token", "ghp_SECRETTOKEN12345");
  const services = createServices({ db, dataDir: path.join(base, "data"), fetchImpl });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  return { app, db, dir, base, events, services, srv: getServer(db, "mc") };
}
async function as(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  const cookie = `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
  const call = (m, u, p) => f.app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" ? undefined : (p ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p) };
}
const waitJob = async (a, id) => until(async () => { const j = (await a.get(`/api/jobs/${id}`)).json(); return j.status !== "running" ? j : null; }, 20000);

test("redaction blanks secret-looking values and leaves the rest", () => {
  const r = redactText("motd=hi\nrcon.password=abc\napi-key: zzz\n# token: commented\ndiscord:\n  token: \"xyz\"\nspawn: true\n");
  assert.equal(r.count, 3);
  assert.match(r.text, /motd=hi/);
  assert.match(r.text, /spawn: true/);
  assert.doesNotMatch(r.text, /abc|zzz|xyz/);
  assert.match(r.text, /# token: commented/);
});

test("smart backup: saving is paused (save-off), flushed, copied, then resumed (save-on)", { skip: have ? false : "no tmux" }, async () => {
  const f = setup({ tmux: true });
  const a = await as(f);
  await a.post("/api/servers/mc/start");
  assert.ok(await until(async () => (await f.services.runtime.status(f.srv)) === "up"));
  // when the copy happens, the log must show saving is OFF and not yet back ON
  const real = f.services.runtime.backups.create;
  let during = null;
  f.services.runtime.backups.create = async (...args) => { during = existsSync(f.events) ? readFileSync(f.events, "utf8").trim().split("\n") : []; return real(...args); };
  const r = await a.post("/api/servers/mc/mc/backup");
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(during, ["off"]);
  assert.ok(await until(() => readFileSync(f.events, "utf8").trim().split("\n").join() === "off,on"), "save-on must follow");
  const list = (await a.get("/api/servers/mc/backups")).json();
  assert.equal(list.length, 1);
  spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]);
});

test("smart backup still turns saving back on when the backup fails", { skip: have ? false : "no tmux" }, async () => {
  const f = setup({ tmux: true });
  const a = await as(f);
  await a.post("/api/servers/mc/start");
  assert.ok(await until(async () => (await f.services.runtime.status(f.srv)) === "up"));
  f.services.runtime.backups.create = async () => { throw new Error("disk full"); };
  const r = await a.post("/api/servers/mc/mc/backup");
  assert.equal(r.statusCode, 500);
  assert.ok(await until(() => readFileSync(f.events, "utf8").trim().split("\n").join() === "off,on"), "save-on must still follow");
  spawnSync("tmux", ["kill-session", "-t", `=${SESSION}`]);
});

test("restore: needs the server stopped and the ID typed; keeps the old folder aside; rejects unsafe archives", async () => {
  const f = setup();
  const a = await as(f);
  const first = (await a.post("/api/servers/mc/backups")).json();
  assert.ok(first.name);
  writeFileSync(path.join(f.dir, "world", "level.dat"), "RUINED");
  writeFileSync(path.join(f.dir, "new-file.txt"), "added later");

  await a.post("/api/servers/mc/start"); // dummy: now "up"
  const running = await a.post("/api/servers/mc/mc/restore", { name: first.name, confirm: "mc" });
  assert.equal(running.statusCode, 409);
  assert.equal(readFileSync(path.join(f.dir, "world", "level.dat"), "utf8"), "RUINED", "nothing changed while running");
  await a.post("/api/servers/mc/stop");

  assert.equal((await a.post("/api/servers/mc/mc/restore", { name: first.name, confirm: "nope" })).statusCode, 400);
  assert.equal((await a.post("/api/servers/mc/mc/restore", { name: "../../etc/passwd", confirm: "mc" })).statusCode, 404);
  assert.equal((await as(f, "op", "pw-operator-1").then((o) => o.post("/api/servers/mc/mc/restore", { name: first.name, confirm: "mc" }))).statusCode, 403);

  const ok = await a.post("/api/servers/mc/mc/restore", { name: first.name, confirm: "mc" });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.equal(readFileSync(path.join(f.dir, "world", "level.dat"), "utf8"), "ORIGINAL-WORLD");
  assert.ok(!existsSync(path.join(f.dir, "new-file.txt")));
  const kept = readdirSync(f.base).find((n) => n.startsWith("srv.before-restore-"));
  assert.ok(kept, "old folder kept");
  assert.equal(readFileSync(path.join(f.base, kept, "world", "level.dat"), "utf8"), "RUINED");
  assert.equal(readFileSync(path.join(f.base, kept, "new-file.txt"), "utf8"), "added later");
  assert.ok(!readdirSync(f.base).some((n) => n.includes(".restoring-")), "no temp leftovers");

  // an archive with a ../ path is refused before anything is touched
  const evilDir = path.join(f.base, "data", "backups", "mc");
  mkdirSync(evilDir, { recursive: true });
  const py = spawnSync("python3", ["-c", `
import tarfile,io,sys
t=tarfile.open(sys.argv[1],"w:gz")
for n in ["server.properties","../escape.txt"]:
    d=b"x"; i=tarfile.TarInfo(n); i.size=1; t.addfile(i,io.BytesIO(d))
t.close()`, path.join(evilDir, "20990101T000000Z.tar.gz")]);
  assert.equal(py.status, 0, py.stderr.toString());
  const bad = await a.post("/api/servers/mc/mc/restore", { name: "20990101T000000Z.tar.gz", confirm: "mc" });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /unsafe/);
  assert.equal(readFileSync(path.join(f.dir, "world", "level.dat"), "utf8"), "ORIGINAL-WORLD");
  assert.ok(!existsSync(path.join(f.base, "escape.txt")));
});

test("restore refuses a backup that isn't a Minecraft server", async () => {
  const f = setup();
  const a = await as(f);
  const dirs = path.join(f.base, "data", "backups", "mc");
  mkdirSync(dirs, { recursive: true });
  const junk = path.join(f.base, "junkdir");
  mkdirSync(junk);
  writeFileSync(path.join(junk, "readme.txt"), "not a server");
  spawnSync("tar", ["-czf", path.join(dirs, "20990202T000000Z.tar.gz"), "-C", junk, "."]);
  const r = await a.post("/api/servers/mc/mc/restore", { name: "20990202T000000Z.tar.gz", confirm: "mc" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /server\.properties/);
  assert.equal(readFileSync(path.join(f.dir, "world", "level.dat"), "utf8"), "ORIGINAL-WORLD");
});

test("world reset moves the world aside (never deletes), only when stopped and confirmed", async () => {
  const f = setup();
  const a = await as(f);
  assert.equal((await a.post("/api/servers/mc/mc/reset-world", { confirm: "x" })).statusCode, 400);
  await a.post("/api/servers/mc/start");
  assert.equal((await a.post("/api/servers/mc/mc/reset-world", { confirm: "mc" })).statusCode, 409);
  assert.ok(existsSync(path.join(f.dir, "world", "level.dat")));
  await a.post("/api/servers/mc/stop");
  const r = await a.post("/api/servers/mc/mc/reset-world", { confirm: "mc" });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(!existsSync(path.join(f.dir, "world")));
  assert.ok(!existsSync(path.join(f.dir, "world_nether")));
  assert.equal(readFileSync(path.join(f.dir, r.json().movedTo, "world", "level.dat"), "utf8"), "ORIGINAL-WORLD");
  assert.ok(existsSync(path.join(f.dir, "plugins", "Big.jar")), "plugins untouched");
  assert.equal((await a.post("/api/servers/mc/mc/reset-world", { confirm: "mc" })).statusCode, 400, "nothing left to reset");
});

test("a hostile level-name can't make reset touch anything outside the server", async () => {
  const f = setup();
  const a = await as(f);
  writeFileSync(path.join(f.dir, "server.properties"), "level-name=../srv\n");
  const r = await a.post("/api/servers/mc/mc/reset-world", { confirm: "mc" });
  assert.equal(r.statusCode, 400);
  assert.ok(existsSync(path.join(f.dir, "plugins", "Big.jar")));
});

// ---- GitHub: config push (real git, redirected to a local bare repo) -------------------------
test("config push: secrets blanked, no jars/worlds, token never in logs, unchanged => no new commit", async () => {
  const f = setup();
  const a = await as(f);
  const bare = path.join(f.base, "remote.git");
  assert.equal(spawnSync("git", ["init", "--bare", "-q", bare]).status, 0);
  const gcfg = path.join(f.base, "gitconfig");
  writeFileSync(gcfg, `[url "file://${bare}"]\n\tinsteadOf = https://github.com/MyTeam/mc-backups.git\n`);
  process.env.GIT_CONFIG_GLOBAL = gcfg;
  try {
    assert.equal((await a.put("/api/servers/mc/mc/github", { repo: "https://x:tok@github.com/a/b" })).statusCode, 400);
    assert.equal((await a.put("/api/servers/mc/mc/github", { repo: "MyTeam/mc-backups", keep: 3 })).statusCode, 200);
    assert.equal((await as(f, "op", "pw-operator-1").then((o) => o.post("/api/servers/mc/mc/github/push-config"))).statusCode, 403);
    const start = await a.post("/api/servers/mc/mc/github/push-config");
    assert.equal(start.statusCode, 200, start.body);
    const job = await waitJob(a, start.json().jobId);
    assert.equal(job.status, "done", job.log);
    assert.ok(!job.log.includes("ghp_SECRETTOKEN12345"));
    assert.equal(job.result.changed, true);
    const files = spawnSync("git", ["--git-dir", bare, "ls-tree", "-r", "--name-only", "servers/mc"]).stdout.toString().split("\n").filter(Boolean);
    assert.ok(files.includes("server.properties"));
    assert.ok(files.includes("plugins/Essentials/config.yml"));
    assert.ok(files.includes("config/paper.yml"));
    assert.ok(!files.some((x) => x.endsWith(".jar") || x.startsWith("world")));
    const props = spawnSync("git", ["--git-dir", bare, "show", "servers/mc:server.properties"]).stdout.toString();
    assert.doesNotMatch(props, /hunter2/);
    assert.match(props, /motd=hi/);
    const yml = spawnSync("git", ["--git-dir", bare, "show", "servers/mc:plugins/Essentials/config.yml"]).stdout.toString();
    assert.doesNotMatch(yml, /abcd1234|xyz/);
    assert.match(yml, /spawn: true/);
    // the real files on disk were not touched
    assert.match(readFileSync(path.join(f.dir, "server.properties"), "utf8"), /hunter2/);

    const again = await waitJob(a, (await a.post("/api/servers/mc/mc/github/push-config")).json().jobId);
    assert.equal(again.status, "done", again.log);
    assert.equal(again.result.changed, false);
    writeFileSync(path.join(f.dir, "config", "paper.yml"), "x: 2\n");
    const third = await waitJob(a, (await a.post("/api/servers/mc/mc/github/push-config")).json().jobId);
    assert.equal(third.result.changed, true);
    const n = spawnSync("git", ["--git-dir", bare, "rev-list", "--count", "servers/mc"]).stdout.toString().trim();
    assert.equal(n, "2");
  } finally {
    delete process.env.GIT_CONFIG_GLOBAL;
  }
});

test("config push without a repo or token says what's missing", async () => {
  const f = setup();
  const a = await as(f);
  const r = await a.post("/api/servers/mc/mc/github/push-config");
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /repo/i);
  f.db.prepare("DELETE FROM settings WHERE key='github_token'").run();
  await a.put("/api/servers/mc/mc/github", { repo: "MyTeam/mc-backups" });
  const r2 = await a.post("/api/servers/mc/mc/github/push-world");
  assert.match(r2.json().error, /token/i);
});

// ---- GitHub: world upload (fake GitHub) ----------------------------------------------------
test("world push: tarball uploaded as a release asset, old ones pruned (only this server's), token only to GitHub", async () => {
  const calls = [];
  const existing = ["world-mc-20240101T000000Z", "world-mc-20240102T000000Z", "world-mc-20240103T000000Z", "world-mc-20240104T000000Z", "world-other-20240101T000000Z", "v1.0"].map((t, i) => ({ id: 100 + i, tag_name: t }));
  let uploaded = null;
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    calls.push({ method: opts.method ?? "GET", url, auth: opts.headers?.authorization });
    if (u.hostname === "uploads.github.com") {
      const chunks = [];
      for await (const c of opts.body) chunks.push(c);
      uploaded = { name: u.searchParams.get("name"), bytes: Buffer.concat(chunks), type: opts.headers["content-type"], len: opts.headers["content-length"] };
      return new Response("{}", { status: 201 });
    }
    if (u.pathname === "/repos/MyTeam/mc-backups/releases" && opts.method === "POST") return new Response(JSON.stringify({ id: 999, tag_name: JSON.parse(opts.body).tag_name }), { status: 201 });
    if (u.pathname === "/repos/MyTeam/mc-backups/releases") return new Response(JSON.stringify([...existing, { id: 999, tag_name: calls.find((c) => c.method === "POST" && c.url.endsWith("/releases")) && uploaded ? `world-mc-${"99990101T000000Z"}` : "x" }]), { status: 200 });
    if (opts.method === "DELETE") return new Response(null, { status: 204 });
    return new Response("nope", { status: 404 });
  };
  const f = setup({ fetchImpl });
  const a = await as(f);
  await a.put("/api/servers/mc/mc/github", { repo: "MyTeam/mc-backups", keep: 2 });
  const start = await a.post("/api/servers/mc/mc/github/push-world");
  assert.equal(start.statusCode, 200, start.body);
  const job = await waitJob(a, start.json().jobId);
  assert.equal(job.status, "done", job.log);
  assert.ok(uploaded, "asset uploaded");
  assert.match(uploaded.name, /^world-mc-\d{8}T\d{6}Z\.tar\.gz$/);
  assert.equal(uploaded.type, "application/gzip");
  assert.equal(String(uploaded.bytes.length), uploaded.len);
  const list = spawnSync("tar", ["-tzf", "-"], { input: uploaded.bytes }).stdout.toString();
  assert.match(list, /world\/level\.dat/);
  assert.match(list, /world_nether\/n\.dat/);
  assert.doesNotMatch(list, /plugins|server\.properties/);
  const deleted = calls.filter((c) => c.method === "DELETE" && c.url.includes("/releases/")).map((c) => Number(c.url.split("/").pop()));
  // keep=2: the new one (tag 9999…) and the newest old one stay; three older world-mc releases go; "other" and "v1.0" untouched
  assert.deepEqual(deleted.sort(), [100, 101, 102]);
  assert.ok(!deleted.includes(104) && !deleted.includes(105));
  assert.ok(calls.every((c) => new URL(c.url).hostname.endsWith("github.com")));
  assert.ok(!job.log.includes("ghp_SECRETTOKEN12345"));
});

test("world push: GitHub's 'empty repo' refusal becomes a clear message", async () => {
  const fetchImpl = async (url, opts = {}) => (opts.method === "POST" ? new Response("{}", { status: 422 }) : new Response("[]", { status: 200 }));
  const f = setup({ fetchImpl });
  const a = await as(f);
  await a.put("/api/servers/mc/mc/github", { repo: "MyTeam/mc-backups" });
  const job = await waitJob(a, (await a.post("/api/servers/mc/mc/github/push-world")).json().jobId);
  assert.equal(job.status, "failed");
  assert.match(job.error, /one commit/);
});

// ---- scheduling -----------------------------------------------------------------------------
test("schedules: the Minecraft actions only for Minecraft servers; the scheduler runs them", async () => {
  const f = setup();
  const a = await as(f);
  assert.equal((await a.post("/api/schedules", { serverId: "plain", action: "mc-backup", cron: "0 4 * * *" })).statusCode, 400);
  const ok = await a.post("/api/schedules", { serverId: "mc", action: "mc-backup", cron: "0 4 * * *" });
  assert.equal(ok.statusCode, 200, ok.body);
  const row = f.db.prepare("SELECT * FROM schedules WHERE id = ?").get(ok.json().id);
  const status = await f.services.scheduler.runOne(row, f.srv);
  assert.equal(status, "ok");
  assert.equal((await a.get("/api/servers/mc/backups")).json().length, 1);
});
