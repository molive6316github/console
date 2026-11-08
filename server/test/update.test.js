import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createUpdater } from "../src/updater.js";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";

// ---- real git: a bare "origin", a dev clone that pushes, and an "install" that updates ----
const ID = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: { ...process.env, ...ID }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "console-upd-"));
  const origin = path.join(dir, "origin.git");
  const work = path.join(dir, "work");
  const install = path.join(dir, "install");
  git(dir, "init", "--bare", origin);
  git(dir, "clone", origin, work);
  git(work, "checkout", "-b", "main");
  writeFileSync(path.join(work, "a.txt"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "first");
  git(work, "push", "-u", "origin", "main");
  git(dir, "clone", "--branch", "main", origin, install);
  const push = (msg) => {
    writeFileSync(path.join(work, "a.txt"), `${msg}\n`);
    git(work, "commit", "-am", msg);
    git(work, "push", "origin", "main");
  };
  return { install, push };
}

const noop = [{ name: "noop", cmd: "true", args: [] }];
const boom = [{ name: "boom", cmd: "false", args: [] }];

test("updater: reports how far behind and what changed", async () => {
  const { install, push } = fixture();
  const u = createUpdater({ root: install, buildSteps: noop });
  assert.equal((await u.check({ force: true })).behind, 0);
  push("second");
  const info = await u.check({ force: true });
  assert.equal(info.ok, true);
  assert.equal(info.behind, 1);
  assert.match(info.commits[0], /second/);
});

test("updater: fast-forwards and runs the build steps", async () => {
  const { install, push } = fixture();
  push("second");
  const res = await createUpdater({ root: install, buildSteps: noop }).apply();
  assert.equal(res.ok, true);
  assert.equal(res.updated, true);
  assert.equal(git(install, "log", "-1", "--format=%s"), "second");
  assert.equal(res.steps.some((s) => s.name === "noop" && s.ok), true);
});

test("updater: already up to date means no change and no restart", async () => {
  const { install } = fixture();
  const res = await createUpdater({ root: install, buildSteps: noop }).apply();
  assert.deepEqual([res.ok, res.updated], [true, false]);
});

test("updater: a failing build rolls back to the old commit", async () => {
  const { install, push } = fixture();
  const before = git(install, "rev-parse", "HEAD");
  push("second");
  const res = await createUpdater({ root: install, buildSteps: boom }).apply();
  assert.equal(res.ok, false);
  assert.equal(res.rolledBack, true);
  assert.equal(git(install, "rev-parse", "HEAD"), before);
});

test("updater: parks local changes in a stash instead of blocking", async () => {
  const { install, push } = fixture();
  writeFileSync(path.join(install, "a.txt"), "my local edit\n");
  push("second");
  const res = await createUpdater({ root: install, buildSteps: noop }).apply();
  assert.equal(res.ok, true);
  assert.notEqual(readFileSync(path.join(install, "a.txt"), "utf8"), "my local edit\n");
  assert.match(git(install, "stash", "list"), /console-auto/);
});

test("updater: a failed fetch is reported, not thrown", async () => {
  const { install } = fixture();
  git(install, "remote", "set-url", "origin", path.join(install, "does-not-exist.git"));
  const info = await createUpdater({ root: install, buildSteps: noop }).check({ force: true });
  assert.equal(info.ok, false);
  assert.ok(info.error.length > 0);
});

test("updater: rejects a branch name that looks like a git option", () => {
  assert.throws(() => createUpdater({ branch: "--upload-pack=evil" }));
});

// ---- routes, with a fake updater ----
function routeSetup(result, opts = {}) {
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)");
  add.run("boss", hashPassword("pw-admin"), "admin");
  add.run("op", hashPassword("pw-op"), "operator");
  const updater = {
    check: async () => ({ supported: true, ok: true, current: "aaa", latest: "bbb", behind: 1, ahead: 0, dirty: false, commits: ["bbb x"] }),
    apply: async () => result,
  };
  let restarts = 0;
  const app = buildApp({ db, updater, canRestart: () => opts.canRestart ?? true, onRestart: () => restarts++, restartDelayMs: 0 });
  return { app, db, restarts: () => restarts };
}
async function login(app, u, p) {
  const res = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } });
  return `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
}
const tick = () => new Promise((r) => setTimeout(r, 30));

test("update routes are admin only", async () => {
  const { app } = routeSetup({ ok: true, updated: false, steps: [] });
  const op = await login(app, "op", "pw-op");
  assert.equal((await app.inject({ url: "/api/update", headers: { cookie: op } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/update", headers: { cookie: op }, payload: {} })).statusCode, 403);
  const boss = await login(app, "boss", "pw-admin");
  assert.equal((await app.inject({ url: "/api/update", headers: { cookie: boss } })).json().behind, 1);
});

test("a successful update is audited and triggers exactly one restart", async () => {
  const { app, db, restarts } = routeSetup({ ok: true, updated: true, steps: [], from: "aaa", to: "bbb" });
  const boss = await login(app, "boss", "pw-admin");
  const res = await app.inject({ method: "POST", url: "/api/update", headers: { cookie: boss }, payload: {} });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().restarting, true);
  await tick();
  assert.equal(restarts(), 1);
  assert.equal(db.prepare("SELECT detail FROM audit_log WHERE action = 'update'").get().detail, "aaa -> bbb");
});

test("no restart when nothing changed, when not under systemd, or when the update failed", async () => {
  for (const [result, opts] of [
    [{ ok: true, updated: false, steps: [] }, {}],
    [{ ok: true, updated: true, steps: [], from: "a", to: "b" }, { canRestart: false }],
    [{ ok: false, updated: false, steps: [], error: "boom" }, {}],
  ]) {
    const { app, restarts } = routeSetup(result, opts);
    const boss = await login(app, "boss", "pw-admin");
    const res = await app.inject({ method: "POST", url: "/api/update", headers: { cookie: boss }, payload: {} });
    assert.equal(res.statusCode, result.ok ? 200 : 500);
    await tick();
    assert.equal(restarts(), 0);
  }
});

// ---- release channel: npm decides when, git carries the code ----
import { createAutoUpdate } from "../src/autoupdate.js";
import { setSetting } from "../src/db.js";

function releaseFixture() {
  const f = fixture();
  return f;
}
const registry = (version, gitHead) => async () => ({ ok: true, status: 200, json: async () => ({ version, gitHead }) });
const withPkg = (dir, version) => {
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mxt-console", version }));
};

test("release channel: ignores new commits until a newer version is published, then updates to exactly that commit", async () => {
  const { install, push } = fixture();
  const work = path.join(path.dirname(install), "work");
  withPkg(work, "1.0.0"); git(work, "add", "."); git(work, "commit", "-m", "v1.0.0"); git(work, "push", "origin", "main");
  git(install, "pull", "--ff-only");
  const v1 = git(install, "rev-parse", "HEAD");
  // main moves on, two commits; only the first becomes release 1.1.0
  withPkg(work, "1.1.0"); git(work, "commit", "-am", "release 1.1.0"); const rel = git(work, "rev-parse", "HEAD");
  push("unreleased work"); // pushes both
  // npm still says 1.0.0 → nothing to do
  let u = createUpdater({ root: install, buildSteps: noop, channel: "release", fetchImpl: registry("1.0.0", v1) });
  assert.equal((await u.check({ force: true })).behind, 0);
  // npm says 1.1.0 → stop at the released commit, not at main's head
  u = createUpdater({ root: install, buildSteps: noop, channel: "release", fetchImpl: registry("1.1.0", rel) });
  const info = await u.check({ force: true });
  assert.equal(info.behind, 1);
  assert.equal(info.latestVersion, "1.1.0");
  const res = await u.apply();
  assert.equal(res.ok, true);
  assert.equal(git(install, "rev-parse", "HEAD"), rel);
  assert.equal(git(install, "log", "-1", "--format=%s"), "release 1.1.0");
});

test("release channel: refuses a release whose commit isn't on the remote, a missing gitHead, and a registry outage", async () => {
  const { install } = fixture();
  withPkg(install, "1.0.0");
  git(install, "update-index", "--assume-unchanged", "a.txt");
  const bogus = "a".repeat(40);
  let r = await createUpdater({ root: install, buildSteps: noop, channel: "release", fetchImpl: registry("1.2.0", bogus) }).check({ force: true });
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't on origin\/main yet/);
  r = await createUpdater({ root: install, buildSteps: noop, channel: "release", fetchImpl: registry("1.2.0", undefined) }).check({ force: true });
  assert.match(r.error, /doesn't say which commit/);
  r = await createUpdater({ root: install, buildSteps: noop, channel: "release", fetchImpl: async () => ({ ok: false, status: 503 }) }).check({ force: true });
  assert.match(r.error, /503/);
});

test("auto-update: only at its hour, waits for players, tries once a day, notifies, restarts", async () => {
  const db = openDb(":memory:");
  setSetting(db, "timezone", "UTC");
  const sent = [];
  let behind = 1, applied = 0, restarted = 0, players = true;
  const updater = {
    check: async () => ({ supported: true, ok: true, behind, current: "aaa", latestVersion: "9.9.9" }),
    apply: async () => (applied++, { ok: true, updated: true, from: "aaa", to: "bbb", steps: [] }),
  };
  let t = Date.UTC(2026, 10, 8, 3, 30);
  const au = createAutoUpdate({ db, updater, notifier: { send: async (m) => sent.push(m) }, playersOnline: async () => players, restart: () => restarted++, now: () => t });
  assert.deepEqual(await au.tick(), { skipped: "off" });
  au.set({ enabled: true, hour: 4 });
  assert.deepEqual(await au.tick(), { skipped: "not the hour" });
  t = Date.UTC(2026, 10, 8, 4, 5);
  assert.deepEqual(await au.tick(), { postponed: true });
  assert.equal(applied, 0, "never while someone is playing");
  players = false; t += 10 * 60_000;
  assert.deepEqual(await au.tick(), { updated: true });
  assert.equal(applied, 1); assert.equal(restarted, 1);
  assert.match(sent[0], /aaa → bbb/);
  t += 10 * 60_000;
  assert.deepEqual(await au.tick(), { skipped: "already tried today" });
  t += 86_400_000; behind = 0;
  assert.deepEqual(await au.tick(), { upToDate: true });
  assert.throws(() => au.set({ hour: 25 }), /0 to 23/);
});
