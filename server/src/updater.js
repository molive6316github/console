import { existsSync } from "node:fs";
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
} = {}) {
  if (!BRANCH_RE.test(branch)) throw new Error("Bad update branch name");

  const steps = buildSteps ?? [
    { name: "npm install", cmd: "npm", args: ["install", "--no-audit", "--no-fund"], timeout: 300_000 },
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
    const behind = await count("HEAD..FETCH_HEAD");
    const ahead = await count("FETCH_HEAD..HEAD");
    const commits = (await git(["log", "--format=%h %s", "--max-count=20", "HEAD..FETCH_HEAD"])).stdout
      .split("\n")
      .filter(Boolean);
    const dirty = (await git(["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== "";
    const data = {
      supported: true,
      ok: true,
      branch,
      current: (await git(["rev-parse", "--short", "HEAD"])).stdout.trim(),
      latest: (await git(["rev-parse", "--short", "FETCH_HEAD"])).stdout.trim(),
      behind,
      ahead,
      dirty,
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
      if (info.dirty) return fail("Tracked files have local changes, so updating would overwrite them. Refusing.");
      if (info.behind === 0) return { ok: true, updated: false, steps: log, from: info.current, to: info.current };
      if (info.ahead > 0) return fail("This install has commits that aren't on the remote, so it can't fast-forward.");

      const oldHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
      if (!record("git merge (fast-forward only)", await git(["merge", "--ff-only", "FETCH_HEAD"]))) {
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

  return { check, apply, current };
}

export const updater = createUpdater();
