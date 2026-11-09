import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./drivers/exec.js";

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;

const tail = (s, lines = 25) => String(s ?? "").trim().split("\n").slice(-lines).join("\n").slice(-2500);

// Self-update from the git remote. Nothing here takes input from the web: the commands,
// remote and branch are fixed at startup (branch can be set with CONSOLE_UPDATE_BRANCH).
export function createUpdater({
  root = defaultRoot,
  remote = "origin",
  branch = process.env.CONSOLE_UPDATE_BRANCH || "main",
  buildSteps,
  // "release": only move to the code of the newest version published on npm (npm is the release gate, GitHub carries the code).
  // "main": follow the branch head.
  channel = "main",
  fetchImpl = fetch,
  pkgName = "mxt-console",
} = {}) {
  if (!BRANCH_RE.test(branch)) throw new Error("Bad update branch name");

  const steps = buildSteps ?? [
    { name: "npm install", cmd: "npm", args: ["install", "--no-package-lock", "--no-audit", "--no-fund"], timeout: 300_000 },
    { name: "npm run build", cmd: "npm", args: ["run", "build"], timeout: 180_000 },
  ];
  // Never let git sit waiting for a password prompt nobody can answer.
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
  const git = (args, timeout = 60_000) => run("git", args, { cwd: root, env, timeout });
  const isCheckout = () => existsSync(path.join(root, ".git"));

  let busy = false;
  let cache = null; // successful checks only, 30s

  async function current() {
    if (!isCheckout()) return null;
    const r = await git(["rev-parse", "--short", "HEAD"]);
    return r.code === 0 ? r.stdout.trim() : null;
  }

  const localVersion = () => {
    try { return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version ?? "0.0.0"; } catch { return "0.0.0"; }
  };
  const cmp = (a, b) => {
    const x = String(a).split(".").map((n) => parseInt(n, 10) || 0), y = String(b).split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0) ? -1 : 1;
    return 0;
  };

  async function latestRelease() {
    const res = await fetchImpl(`https://registry.npmjs.org/${pkgName}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`npm registry answered ${res.status}`);
    const j = await res.json();
    if (!/^\d+\.\d+\.\d+$/.test(String(j.version))) throw new Error("npm returned an odd version");
    return { version: j.version, gitHead: /^[0-9a-f]{40}$/.test(String(j.gitHead ?? "")) ? j.gitHead : null };
  }

  async function check({ force = false } = {}) {
    if (!isCheckout()) {
      return { supported: false, error: "This install is not a git checkout, so it can't update itself." };
    }
    if (!force && cache && Date.now() - cache.at < 30_000) return cache.data;

    const fetched = await git(["fetch", "--quiet", remote, branch]);
    if (fetched.code !== 0) {
      return { supported: true, ok: false, error: tail(fetched.stderr || fetched.stdout || "git fetch failed", 6) };
    }
    const count = async (range) => parseInt((await git(["rev-list", "--count", range])).stdout, 10) || 0;
    let target = "FETCH_HEAD";
    let release = null;
    if (channel === "release") {
      const have = localVersion();
      try {
        release = await latestRelease();
      } catch (e) {
        return { supported: true, ok: false, error: `Couldn't check npm for new releases: ${e.message}` };
      }
      if (cmp(release.version, have) <= 0) target = "HEAD"; // nothing newer is published
      else if (!release.gitHead) return { supported: true, ok: false, error: `Version ${release.version} is published but npm doesn't say which commit it came from.` };
      else {
        const known = (await git(["cat-file", "-e", `${release.gitHead}^{commit}`])).code === 0;
        const onBranch = known && (await git(["merge-base", "--is-ancestor", release.gitHead, "FETCH_HEAD"])).code === 0;
        if (!onBranch) return { supported: true, ok: false, error: `Version ${release.version} is published, but its code isn't on ${remote}/${branch} yet. Push it, then check again.` };
        target = release.gitHead;
      }
    }
    const behind = await count(`HEAD..${target}`);
    const ahead = await count(`${target}..HEAD`);
    const commits = (await git(["log", "--format=%h %s", "--max-count=20", `HEAD..${target}`])).stdout
      .split("\n")
      .filter(Boolean);
    // npm rewrites lockfiles on its own; that's never a change worth protecting, so drop it quietly.
    await git(["checkout", "--", "package-lock.json", "web/package-lock.json"]);
    const listDirty = async () => (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.split("\n").map((l) => l.slice(3).trim()).filter(Boolean);
    const dirtyFiles = await listDirty();
    const dirty = dirtyFiles.length > 0;
    const data = {
      supported: true,
      ok: true,
      branch,
      current: (await git(["rev-parse", "--short", "HEAD"])).stdout.trim(),
      latest: (await git(["rev-parse", "--short", target])).stdout.trim(),
      target: (await git(["rev-parse", target])).stdout.trim(),
      channel,
      version: localVersion(),
      latestVersion: release && cmp(release.version, localVersion()) > 0 ? release.version : null,
      behind,
      ahead,
      dirty,
      dirtyFiles,
      commits,
    };
    cache = { at: Date.now(), data };
    return data;
  }

  async function apply() {
    if (busy) return { ok: false, updated: false, steps: [], error: "An update is already running" };
    busy = true;
    const log = [];
    const record = (name, r) => {
      log.push({ name, ok: r.code === 0, output: tail(`${r.stdout}\n${r.stderr}`) });
      return r.code === 0;
    };
    const runStep = (s) => run(s.cmd, s.args, { cwd: root, env, timeout: s.timeout ?? 120_000 });
    const fail = (error, extra = {}) => ({ ok: false, updated: false, steps: log, error, ...extra });

    try {
      const info = await check({ force: true });
      if (!info.supported || !info.ok) return fail(info.error ?? "Can't check for updates");
      if (info.behind === 0) return { ok: true, updated: false, steps: log, from: info.current, to: info.current };
      if (info.dirty) {
        // Nobody should hand-edit a managed install. Park the changes in a git stash (recoverable) instead of blocking the update.
        record("park local changes (git stash)", await git(["stash", "push", "-m", `console-auto-${Date.now()}`]));
        if ((await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim()) await git(["checkout", "--", "."]);
        if ((await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim()) return fail(`Couldn't clear local changes to ${info.dirtyFiles.slice(0, 5).join(", ")}.`);
      }
      if (info.ahead > 0) return fail("This install has commits that aren't on the remote, so it can't fast-forward.");

      const oldHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
      if (!record("git merge (fast-forward only)", await git(["merge", "--ff-only", info.target]))) {
        return fail("git merge failed");
      }

      for (const s of steps) {
        if (record(s.name, await runStep(s))) continue;
        // Something broke: put the old code (and a working build) back.
        record("rollback: git reset", await git(["reset", "--hard", oldHead]));
        for (const s2 of steps) record(`rollback: ${s2.name}`, await runStep(s2));
        cache = null;
        return fail(`${s.name} failed. Rolled back to ${info.current}.`, { rolledBack: true });
      }

      cache = null;
      const to = (await git(["rev-parse", "--short", "HEAD"])).stdout.trim();
      return { ok: true, updated: true, steps: log, from: info.current, to };
    } finally {
      busy = false;
    }
  }

  return { check, apply, current, channel };
}

export const updater = createUpdater({ channel: process.env.CONSOLE_UPDATE_CHANNEL === "main" ? "main" : "release" });
