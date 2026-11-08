import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { createDiscover, assertSafeToRemove, parseTmux, parsePs, parseJsonLines, parseSystemdShow, DiscoverError } from "../src/discover.js";
import systemd from "../src/drivers/systemd.js";

// ---- parsers on realistic output ------------------------------------------------------------
test("parses tmux session + pane listings", () => {
  const s = parseTmux("uhc|~|1730000000|~|0|~|1\nsmp|~|1730000100|~|1|~|2\n", 'uhc|~|/srv/uhc|~|"java -jar paper.jar"\nsmp|~|/srv/smp|~|\nsmp|~|/other|~|ignored\n');
  assert.deepEqual(s.map((x) => [x.name, x.attached, x.windows, x.cwd, x.command]), [
    ["uhc", false, 1, "/srv/uhc", "java -jar paper.jar"],
    ["smp", true, 2, "/srv/smp", null],
  ]);
});

test("parses docker json lines, ps, and systemctl show", () => {
  assert.equal(parseJsonLines('{"ID":"a"}\nwarning: stuff\n{"ID":"b"}\n{broken\n').length, 2);
  const ps = parsePs("  10 root 500 900000 /usr/bin/java -jar server.jar\n  11 root 5 100 [kworker/0:1]\n  12 opc 7 5000 tiny\n 999 opc 1 800000 node app.js\n", { selfPid: 999 });
  assert.deepEqual(ps.map((p) => p.pid), [10]);
  const u = parseSystemdShow("Id=a.service\nDescription=Thing A\nActiveState=active\nSubState=running\n\nId=b.service\nDescription=B = with equals\nActiveState=inactive\nSubState=dead\n");
  assert.equal(u[1].Description, "B = with equals");
});

// ---- fixture ---------------------------------------------------------------------------------
function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "console-disc-"));
  const srv = path.join(base, "srv");
  const home = path.join(base, "home");
  const data = path.join(base, "data");
  const self = path.join(base, "opt", "console");
  for (const d of [srv, path.join(home, "opc"), data, self]) mkdirSync(d, { recursive: true });
  const db = openDb(":memory:");
  const mk = (rel, files = {}) => {
    const dir = path.join(base, rel);
    mkdirSync(dir, { recursive: true });
    for (const [n, c] of Object.entries(files)) writeFileSync(path.join(dir, n), c);
    return dir;
  };
  const disc = (extra = {}) =>
    createDiscover({ db, dataDir: data, selfDir: self, baseRoots: [srv], homeDir: home, ...extra });
  return { base, srv, home, data, self, db, mk, disc };
}

test("folders: lists real directories under the scan roots with sizes and tags; flags protected ones", async () => {
  const f = fixture();
  f.mk("srv/old-world", { "server.properties": "x=1", "paper.jar": "x".repeat(5000) });
  f.mk("srv/managed", { "a.txt": "a" });
  f.mk("home/opc/notes", { "n.md": "hi" });
  f.db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('m', 'Managed', 'dummy', ?, 'ui')").run(JSON.stringify({ filesRoot: path.join(f.srv, "managed") }));
  symlinkSync(f.mk("elsewhere/target"), path.join(f.srv, "linkdir"));
  writeFileSync(path.join(f.srv, "afile.txt"), "x");
  mkdirSync(path.join(f.srv, ".hidden"));

  const r = await f.disc().folders();
  const by = Object.fromEntries(r.folders.map((x) => [x.name, x]));
  assert.deepEqual(Object.keys(by).sort(), ["managed", "notes", "old-world"], "no symlinks, plain files or dot-folders");
  assert.ok(by["old-world"].tags.includes("minecraft") && by["old-world"].tags.includes("java"));
  assert.ok(by["old-world"].sizeKB >= 4);
  assert.match(by.managed.protected, /Remove that server from Console first/);
  assert.equal(by.managed.managedBy, "m");
  assert.equal(by["old-world"].protected, null);
  assert.equal(r.folders[0].name, "old-world", "biggest first");
});

test("deleting a folder: requires the exact name, refuses anything Console didn't scan", async () => {
  const f = fixture();
  const dir = f.mk("srv/junk", { "a.txt": "a" });
  const d = f.disc();
  const fails = async (arg, re, status) =>
    assert.rejects(d.deleteFolder(arg), (e) => e instanceof DiscoverError && re.test(e.message) && (status === undefined || e.status === status));

  await fails({ path: dir, confirm: "wrong" }, /type the folder name exactly: junk/);
  await fails({ path: dir }, /type the folder name/);
  const decoy = f.mk("decoy/etc", { passwd: "root" }); // stands in for a system folder that is NOT under a scan root
  await fails({ path: decoy, confirm: "etc" }, /isn't one of the folders/, 404);
  await fails({ path: path.dirname(decoy), confirm: "decoy" }, /isn't one of the folders/, 404);
  await fails({ path: dir + "/" , confirm: "junk" }, /isn't one of the folders/, 404);
  await fails({ path: `${f.srv}/../srv/junk`, confirm: "junk" }, /isn't one of the folders/, 404);
  await fails({ path: `${f.srv}/./junk`, confirm: "junk" }, /isn't one of the folders/, 404);
  await fails({ path: path.join(dir, "a.txt"), confirm: "a.txt" }, /isn't one of the folders/, 404);
  await fails({ path: 5 }, /Pick a folder/);
  assert.ok(existsSync(path.join(dir, "a.txt")), "nothing was deleted by any of those");
  assert.ok(existsSync(path.join(decoy, "passwd")), "the decoy 'system folder' survives");

  const ok = await d.deleteFolder({ path: dir, confirm: "junk" });
  assert.equal(ok.ok, true);
  assert.equal(existsSync(dir), false);
});

test("a symlinked folder can't be used to delete what it points at", async () => {
  const f = fixture();
  const target = f.mk("elsewhere/precious", { "keep.txt": "keep" });
  symlinkSync(target, path.join(f.srv, "shortcut"));
  await assert.rejects(f.disc().deleteFolder({ path: path.join(f.srv, "shortcut"), confirm: "shortcut" }), /isn't one of the folders/);
  assert.ok(existsSync(path.join(target, "keep.txt")));
});

test("protected folders can't be deleted: Console itself, its data, a managed server's files, scan roots", async () => {
  const f = fixture();
  // make the "self" and "data" dirs look like scan candidates by rooting a scan at their parents
  const d = f.disc({ extraRoots: [path.dirname(f.self), f.base] });
  const managedDir = f.mk("srv/live", { "a": "a" });
  f.db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('live', 'Live', 'dummy', ?, 'ui')").run(JSON.stringify({ filesRoot: managedDir }));
  for (const [p, name, re] of [
    [f.self, "console", /Console itself/],
    [f.data, "data", /database and backups/],
    [managedDir, "live", /Used by "Live"/],
    [path.dirname(f.self), "opt", /Console itself/], // contains Console
  ]) {
    await assert.rejects(d.deleteFolder({ path: p, confirm: name }), (e) => e.status === 409 && re.test(e.message), p);
    assert.ok(existsSync(p), `${p} must survive`);
  }
});

test("a folder something is running from is refused until it's stopped", async () => {
  const f = fixture();
  const dir = f.mk("srv/running", { "a": "a" });
  const child = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
  after(() => child.kill());
  await new Promise((r) => setTimeout(r, 200));
  const d = f.disc();
  await assert.rejects(d.deleteFolder({ path: dir, confirm: "running" }), (e) => e.status === 409 && /still running from this folder: process \d+ \(sleep 30\)/.test(e.message));
  assert.ok(existsSync(dir));
  child.kill();
  await new Promise((r) => child.once("exit", r));
  await d.deleteFolder({ path: dir, confirm: "running" });
  assert.equal(existsSync(dir), false);
});

test("safety copy: archive is written first and contains the files; if it can't be made, nothing is deleted", async () => {
  const f = fixture();
  const dir = f.mk("srv/world one", { "level.dat": "DATA" });
  const d = f.disc();
  const r = await d.deleteFolder({ path: dir, confirm: "world one", archive: true });
  assert.match(r.archived, /^world_one-\d{8}T\d{6}Z\.tar\.gz$/);
  const listing = execFileSync("tar", ["-tzf", path.join(f.data, "backups", "_deleted", r.archived)]).toString();
  assert.match(listing, /world one\/level\.dat/);
  assert.equal(existsSync(dir), false);

  const g = fixture();
  const dir2 = g.mk("srv/keepme", { "x": "x" });
  mkdirSync(path.join(g.data, "backups"), { recursive: true });
  writeFileSync(path.join(g.data, "backups", "_deleted"), "i am a file, so the archive folder can't be made");
  await assert.rejects(g.disc().deleteFolder({ path: dir2, confirm: "keepme", archive: true }));
  assert.ok(existsSync(dir2), "no safety copy => no deletion");
});

test("files owned by someone else: reports honestly instead of claiming success", { skip: process.getuid?.() === 0 ? "running as root can delete anything" : false }, async () => {
  const f = fixture();
  const dir = f.mk("srv/locked", { "a": "a" });
  mkdirSync(path.join(dir, "sub"));
  writeFileSync(path.join(dir, "sub", "b"), "b");
  chmodSync(path.join(dir, "sub"), 0o500);
  after(() => chmodSync(path.join(dir, "sub"), 0o700));
  await assert.rejects(f.disc().deleteFolder({ path: dir, confirm: "locked" }), /Deleted part of it|Couldn't delete/);
});

// ---- tmux (real) -----------------------------------------------------------------------------
const haveTmux = spawnSync("tmux", ["-V"]).status === 0;
test("discovers a real tmux session, offers its folder and command, and kills it", { skip: haveTmux ? false : "no tmux" }, async () => {
  const f = fixture();
  const name = `discover${process.pid}`;
  execFileSync("tmux", ["new-session", "-d", "-s", name, "-c", f.srv, "sleep 300"]);
  after(() => spawnSync("tmux", ["kill-session", "-t", `=${name}`]));
  const d = f.disc();
  const t = await d.tmux();
  const mine = t.sessions.find((s) => s.name === name);
  assert.ok(mine);
  assert.equal(mine.cwd, path.resolve(f.srv));
  assert.match(mine.command, /sleep 300/);
  assert.equal(mine.managedBy, null);
  assert.ok(Array.isArray(t.others));

  f.db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('t', 'T', 'tmux', ?, 'ui')").run(JSON.stringify({ session: name, startCommand: "sleep 300" }));
  assert.equal((await d.tmux()).sessions.find((s) => s.name === name).managedBy, "t");
  await assert.rejects(d.killTmux(name), /Use its Stop button/);
  f.db.prepare("DELETE FROM servers").run();

  await assert.rejects(d.killTmux("a b"), /Bad session name/);
  await assert.rejects(d.killTmux("-t"), /Bad session name/);
  await d.killTmux(name);
  assert.equal(spawnSync("tmux", ["has-session", "-t", `=${name}`]).status, 1);
});

// ---- docker (fake CLI) -----------------------------------------------------------------------
function fakeDocker(calls, { fail } = {}) {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (fail) return { code: 1, stdout: "", stderr: fail };
    const key = args.slice(0, 2).join(" ");
    if (key === "ps -a") return { code: 0, stderr: "", stdout: '{"ID":"abc123","Names":"mc","Image":"itzg/minecraft-server","State":"running","Status":"Up 2 days","CreatedAt":"x"}\n{"ID":"def456","Names":"old","Image":"nginx:1","State":"exited","Status":"Exited","CreatedAt":"y"}\n' };
    if (args[0] === "images") return { code: 0, stderr: "", stdout: '{"Repository":"itzg/minecraft-server","Tag":"latest","ID":"i1","Size":"700MB","CreatedSince":"1w"}\n{"Repository":"<none>","Tag":"<none>","ID":"i2","Size":"300MB","CreatedSince":"2mo"}\n{"Repository":"nginx","Tag":"1","ID":"i3","Size":"100MB","CreatedSince":"1mo"}\n' };
    if (args[0] === "system") return { code: 0, stderr: "", stdout: '{"Type":"Images","TotalCount":"3","Size":"1.1GB","Reclaimable":"400MB (36%)"}\n' };
    if (args[1] === "prune") return { code: 0, stderr: "", stdout: "Total reclaimed space: 300MB\n" };
    return { code: 0, stdout: "", stderr: "" };
  };
}

test("docker: lists containers/images, marks unused ones, removes safely, never touches volumes", async () => {
  const f = fixture();
  const calls = [];
  const d = f.disc({ run: fakeDocker(calls) });
  const r = await d.docker();
  assert.equal(r.containers.length, 2);
  assert.equal(r.images.find((i) => i.id === "i2").dangling, true);
  assert.equal(r.images.find((i) => i.id === "i1").inUse, true);
  assert.equal(r.images.find((i) => i.id === "i3").inUse, true); // nginx:1 is used by the stopped container "old"

  f.db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mcs', 'MC', 'docker', ?, 'ui')").run(JSON.stringify({ container: "mc" }));
  assert.equal((await d.docker()).containers[0].managedBy, "mcs");
  await assert.rejects(d.dockerRemove({ kind: "container", id: "mc" }), /Remove it from Console first/);

  calls.length = 0;
  await d.dockerRemove({ kind: "container", id: "old" });
  assert.deepEqual(calls.at(-1), ["docker", "rm", "old"]);
  await d.dockerRemove({ kind: "container", id: "old", force: true });
  assert.deepEqual(calls.at(-1), ["docker", "rm", "-f", "old"]);
  await d.dockerRemove({ kind: "image", id: "i2" });
  assert.deepEqual(calls.at(-1), ["docker", "rmi", "i2"]);

  for (const bad of ["-f", "--all", "a b", "a;b", "", "$(x)", 5, null]) {
    await assert.rejects(d.dockerRemove({ kind: "container", id: bad }), /Bad container/, String(bad));
    await assert.rejects(d.dockerRemove({ kind: "image", id: bad }), /Bad image/, String(bad));
  }
  await assert.rejects(d.dockerRemove({ kind: "volume", id: "x" }), /Unknown kind/);

  assert.equal((await d.dockerPrune("images")).reclaimed, "300MB");
  assert.deepEqual(calls.at(-1), ["docker", "image", "prune", "-f"]);
  await assert.rejects(d.dockerPrune("volumes"), /Unknown prune/);
  await assert.rejects(d.dockerPrune("system"), /Unknown prune/);
  assert.equal(calls.some((c) => c.includes("volume")), false, "volumes are never touched");
});

test("docker problems are explained, not dumped", async () => {
  const f = fixture();
  const why = async (stderr) => (await f.disc({ run: fakeDocker([], { fail: stderr }) }).docker()).reason;
  assert.match(await why("spawn docker ENOENT"), /isn't installed/);
  assert.match(await why("permission denied while trying to connect to the Docker daemon socket"), /usermod -aG docker console/);
  assert.match(await why("Cannot connect to the Docker daemon. Is the docker daemon running?"), /isn't running/);
  assert.match(await why("failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct"), /isn't running/);
});

// ---- Console's own leftovers -------------------------------------------------------------------
test("cleanup finds backups of servers that no longer exist, and saved copies of deleted folders", async () => {
  const f = fixture();
  f.db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('alive', 'A', 'dummy', '{}', 'ui')").run();
  for (const id of ["alive", "gone"]) {
    mkdirSync(path.join(f.data, "backups", id), { recursive: true });
    writeFileSync(path.join(f.data, "backups", id, "20260101T000000Z.tar.gz"), "x".repeat(2048));
  }
  mkdirSync(path.join(f.data, "backups", "_deleted"), { recursive: true });
  writeFileSync(path.join(f.data, "backups", "_deleted", "w-1.tar.gz"), "x");
  const d = f.disc();
  const c = await d.cleanup();
  assert.deepEqual(c.orphans.map((o) => o.id), ["gone"]);
  assert.deepEqual(c.archives.map((a) => a.name), ["w-1.tar.gz"]);
  await assert.rejects(d.cleanupDelete({ kind: "orphan", name: "alive" }), /still exists/);
  await assert.rejects(d.cleanupDelete({ kind: "orphan", name: "../data" }), /Bad name/);
  await assert.rejects(d.cleanupDelete({ kind: "archive", name: "../../etc/passwd" }), /Bad name/);
  await d.cleanupDelete({ kind: "orphan", name: "gone" });
  await d.cleanupDelete({ kind: "archive", name: "w-1.tar.gz" });
  assert.deepEqual(readdirSync(path.join(f.data, "backups")).sort(), ["_deleted", "alive"]);
});

// ---- routes ------------------------------------------------------------------------------------
function api({ safeMode = false } = {}) {
  const f = fixture();
  const add = f.db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  const services = createServices({ db: f.db, dataDir: f.data, discoverOptions: { selfDir: f.self, baseRoots: [f.srv], homeDir: f.home, run: fakeDocker([]) } });
  const app = buildApp({ db: f.db, services, safeMode, dataDir: f.data });
  const as = async (u, p) => {
    const l = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } });
    const cookie = `console_session=${l.cookies[0].value}`;
    return (method, url, payload) => app.inject({ method, url, headers: { cookie }, payload: method === "GET" ? undefined : payload ?? {} });
  };
  return { ...f, app, as };
}

test("routes: admin only; deletions are audited; safe mode blocks them but not scanning", async () => {
  const f = api();
  const dir = f.mk("srv/junk", { a: "a" });
  const op = await f.as("op", "pw-operator-1");
  for (const u of ["tmux", "docker", "systemd", "processes", "folders", "cleanup"]) assert.equal((await op("GET", `/api/discover/${u}`)).statusCode, 403, u);
  assert.equal((await op("POST", "/api/discover/folder/delete", { path: dir, confirm: "junk" })).statusCode, 403);

  const boss = await f.as("boss", "pw-admin-123");
  assert.equal((await boss("GET", "/api/discover/folders")).json().folders[0].name, "junk");
  assert.equal((await boss("GET", "/api/discover/docker")).json().containers.length, 2);
  assert.equal((await boss("POST", "/api/discover/folder/delete", { path: dir, confirm: "nope" })).statusCode, 400);
  const decoy = f.mk("decoy/etc", { passwd: "root" });
  assert.equal((await boss("POST", "/api/discover/folder/delete", { path: decoy, confirm: "etc" })).statusCode, 404);
  assert.ok(existsSync(dir) && existsSync(path.join(decoy, "passwd")));
  assert.equal((await boss("POST", "/api/discover/folder/delete", { path: dir, confirm: "junk", archive: true })).statusCode, 200);
  const log = f.db.prepare("SELECT action, ok, detail FROM audit_log WHERE action = 'delete_folder' ORDER BY id").all();
  assert.deepEqual(log.map((l) => l.ok), [0, 0, 1]);
  assert.match(log[2].detail, /junk .*saved copy junk-/);

  const safe = api({ safeMode: true });
  const d2 = safe.mk("srv/junk", { a: "a" });
  const b2 = await safe.as("boss", "pw-admin-123");
  assert.equal((await b2("GET", "/api/discover/folders")).statusCode, 200, "looking is fine");
  assert.equal((await b2("POST", "/api/discover/folder/delete", { path: d2, confirm: "junk" })).statusCode, 403);
  assert.equal((await b2("POST", "/api/discover/docker/remove", { kind: "container", id: "old" })).statusCode, 403);
  assert.ok(existsSync(d2));
});

// ---- local systemd driver ------------------------------------------------------------------------
test("systemd driver with host 'local' runs systemctl directly (no ssh) and explains permission problems", async () => {
  const bin = mkdtempSync(path.join(tmpdir(), "console-fakebin-"));
  const log = path.join(bin, "calls.log");
  writeFileSync(path.join(bin, "systemctl"), `#!/bin/sh\necho "$@" >> ${log}\ncase "$1" in is-active) echo active;; start) echo "Failed to start: Interactive authentication required." >&2; exit 1;; esac\n`, { mode: 0o755 });
  writeFileSync(path.join(bin, "ssh"), `#!/bin/sh\necho SSH-WAS-CALLED >> ${log}\n`, { mode: 0o755 });
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  after(() => (process.env.PATH = oldPath));
  const t = { host: "local", unit: "nginx.service" };
  assert.equal(await systemd.status(t), "up");
  await assert.rejects(systemd.start(t), /Interactive authentication required[\s\S]*sudoers\.d\/console[\s\S]*systemctl start nginx\.service/);
  const calls = (await import("node:fs")).readFileSync(log, "utf8");
  assert.match(calls, /is-active nginx\.service/);
  assert.equal(calls.includes("SSH-WAS-CALLED"), false);
  assert.deepEqual(systemd.validate({ host: "local", unit: "nginx.service", sudo: true }), { host: "local", unit: "nginx.service", sudo: true });
});

test("the final guard before a recursive delete refuses '/', top-level system folders and odd paths, whatever the checks above say", () => {
  for (const p of ["/", "/etc", "/usr", "/home", "/var", "/tmp", "/root", "/srv", "/opt"]) {
    assert.throws(() => assertSafeToRemove(p), DiscoverError, p); // read-only: it only inspects, never deletes
  }
  const base = mkdtempSync(path.join(tmpdir(), "console-guard-"));
  mkdirSync(path.join(base, "real"));
  symlinkSync(path.join(base, "real"), path.join(base, "link"));
  assert.throws(() => assertSafeToRemove(path.join(base, "link")), DiscoverError, "a symlink doesn't resolve to itself");
  assert.doesNotThrow(() => assertSafeToRemove(path.join(base, "real")));
});
