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

test("updater: refuses to overwrite local changes to tracked files", async () => {
  const { install, push } = fixture();
  writeFileSync(path.join(install, "a.txt"), "my local edit\n");
  push("second");
  const res = await createUpdater({ root: install, buildSteps: noop }).apply();
  assert.equal(res.ok, false);
  assert.match(res.error, /local changes/);
  assert.equal(readFileSync(path.join(install, "a.txt"), "utf8"), "my local edit\n");
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
