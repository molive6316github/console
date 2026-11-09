import path from "node:path";
import { mkdir, readdir, readFile, stat, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { getSetting, setSetting } from "./db.js";
import { toolsBin } from "./claudecode.js";

export class AutoFixError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

const RULES = `Rules:
- Only change files inside the current folder. Make the smallest change that fixes the problem.
- Never delete or edit world data (folders like world, world_nether, world_the_end, playerdata, region).
- Don't print or copy secrets (keys, tokens, passwords).
- Don't try to start, stop or restart anything. Console does that after you finish.
- If you can't find a safe fix, change nothing and explain why.
When finished, reply with 2 to 4 sentences: what was wrong, and exactly what you changed.`;

// An agent is anything that can read a task and edit files in a folder. Claude Code and Codex are built in; "custom" is any command.
export const AGENTS = {
  claude: {
    label: "Claude Code",
    bins: () => [path.join(toolsBin(), "claude"), "claude"],
    argv: (bin, task) => [bin, "-p", task, "--allowedTools", "Read", "Write", "Edit", "Glob", "Grep", "--permission-mode", "acceptEdits", "--max-turns", "40"],
  },
  codex: {
    label: "OpenAI Codex",
    bins: () => [path.join(toolsBin(), "codex"), "codex"],
    argv: (bin, task) => [bin, "exec", "--full-auto", "--skip-git-repo-check", task],
  },
};

const DEFAULTS = { enabled: false, agent: "claude", custom: "", scopes: { minecraft: true, console: true, plugins: true, link: true }, maxPerHour: 3, attempts: 2 };
const EXCLUDE = ["world", "world_nether", "world_the_end", "logs", "cache", "libraries", "versions", "crash-reports", "node_modules", "dist", ".git", "backups", "playerdata", "region", "stats", "advancements"];
const SKIP_EXT = /\.(log|gz|zip|tgz|mca|mcr|dat|dat_old|jar|db|sqlite|png|jpg)$/i;

async function walk(dir, base = dir, out = new Map(), depth = 0) {
  if (depth > 6) return out;
  let ents = [];
  try { ents = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!EXCLUDE.includes(e.name)) await walk(path.join(dir, e.name), base, out, depth + 1); continue; }
    if (!e.isFile() || SKIP_EXT.test(e.name)) continue;
    const full = path.join(dir, e.name);
    const s = await stat(full).catch(() => null);
    if (s && s.size < 2_000_000) out.set(path.relative(base, full), { size: s.size, mtime: s.mtimeMs, full });
  }
  return out;
}

// Plain-file snapshot (config/text only, never worlds or jars) so any change can be undone byte for byte.
async function snapshot(dir, saveTo) {
  const files = await walk(dir);
  const index = {};
  await mkdir(saveTo, { recursive: true });
  let n = 0;
  for (const [rel, f] of files) {
    const name = `${n++}`;
    await writeFile(path.join(saveTo, name), await readFile(f.full));
    index[rel] = { name, size: f.size, mtime: f.mtime };
  }
  await writeFile(path.join(saveTo, "index.json"), JSON.stringify(index));
  return index;
}

async function diffAgainst(dir, index) {
  const now = await walk(dir);
  const changed = [];
  for (const [rel, f] of now) {
    const b = index[rel];
    if (!b) changed.push({ file: rel, change: "added" });
    else if (b.size !== f.size || Math.abs(b.mtime - f.mtime) > 1) {
      const same = (await readFile(f.full)).equals(await readFile(path.join(saveToOf(index), b.name)).catch(() => Buffer.alloc(0)));
      if (!same) changed.push({ file: rel, change: "edited" });
    }
  }
  for (const rel of Object.keys(index)) if (!now.has(rel)) changed.push({ file: rel, change: "deleted" });
  return changed;
}
const saveToOf = (index) => index.__dir;

async function restore(dir, snapDir) {
  const index = JSON.parse(await readFile(path.join(snapDir, "index.json"), "utf8"));
  const now = await walk(dir);
  for (const [rel, f] of now) if (!index[rel]) await rm(f.full, { force: true });
  for (const [rel, b] of Object.entries(index)) {
    const dest = path.join(dir, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, await readFile(path.join(snapDir, b.name)));
  }
}

export function createAutoFix({ db, dataDir, jobs, run, scopes, now = () => Date.now(), agents = AGENTS, which = defaultWhich }) {
  const root = path.join(dataDir, "autofix");
  let busy = false;
  const cfg = () => ({ ...DEFAULTS, ...(JSON.parse(getSetting(db, "autofix", "{}") || "{}")), scopes: { ...DEFAULTS.scopes, ...(JSON.parse(getSetting(db, "autofix", "{}") || "{}").scopes ?? {}) } });
  const history = () => JSON.parse(getSetting(db, "autofix_history", "[]"));
  const saveHistory = (h) => setSetting(db, "autofix_history", JSON.stringify(h.slice(0, 30)));
  const patchEntry = (id, patch) => { const h = history(); const i = h.findIndex((x) => x.id === id); if (i >= 0) { h[i] = { ...h[i], ...patch }; saveHistory(h); } return h[i]; };

  async function resolveBin(agentId) {
    const a = agents[agentId];
    if (!a) return null;
    for (const b of a.bins()) if (await which(b)) return b;
    return null;
  }

  async function status() {
    const c = cfg();
    const list = [];
    for (const [id, a] of Object.entries(agents)) list.push({ id, label: a.label, installed: Boolean(await resolveBin(id)) });
    list.push({ id: "custom", label: "Custom command", installed: Boolean(c.custom.trim()) });
    return { ...c, agents: list, history: history() };
  }

  function configure(patch) {
    const cur = cfg();
    const next = { ...cur };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.agent === "string") { if (patch.agent !== "custom" && !agents[patch.agent]) throw new AutoFixError("Unknown agent"); next.agent = patch.agent; }
    if (typeof patch.custom === "string") next.custom = patch.custom.slice(0, 500);
    if (patch.scopes && typeof patch.scopes === "object") for (const k of Object.keys(DEFAULTS.scopes)) if (typeof patch.scopes[k] === "boolean") next.scopes[k] = patch.scopes[k];
    if (Number.isInteger(patch.maxPerHour)) next.maxPerHour = Math.min(20, Math.max(1, patch.maxPerHour));
    setSetting(db, "autofix", JSON.stringify(next));
    return next;
  }

  async function agentArgv(c, task, dir) {
    if (c.agent === "custom") {
      if (!c.custom.trim()) throw new AutoFixError("Type your custom agent command first");
      const file = path.join(root, `task-${now().toString(36)}.md`);
      await mkdir(root, { recursive: true });
      await writeFile(file, task);
      // Your command runs in the folder. The task is in $CONSOLE_TASK and in the file $CONSOLE_TASK_FILE (kept outside the folder).
      return { cmd: "sh", args: ["-c", c.custom], env: { CONSOLE_TASK: task, CONSOLE_TASK_FILE: file } };
    }
    const bin = await resolveBin(c.agent);
    if (!bin) throw new AutoFixError(`${agents[c.agent]?.label ?? c.agent} isn't installed on this machine`);
    const [cmd, ...args] = agents[c.agent].argv(bin, task);
    return { cmd, args, env: {} };
  }

  // scope = { name, dir, evidence(): string, verify(): {ok, detail}, after?(): Promise }
  async function fix({ scope, title, actor, incident }) {
    const c = cfg();
    if (!c.enabled && actor !== "manual") throw new AutoFixError("Auto-fix is off");
    if (!c.scopes[scope.name] && actor !== "manual") throw new AutoFixError(`Auto-fix is off for ${scope.name}`);
    if (busy) throw new AutoFixError("A fix is already running", 409);
    const recent = history().filter((h) => now() - h.at < 3_600_000);
    if (actor !== "manual" && recent.length >= c.maxPerHour) throw new AutoFixError("Hourly auto-fix limit reached. Fix it by hand or raise the limit.", 429);
    if (incident && recent.filter((h) => h.incident === incident).length >= c.attempts) throw new AutoFixError("Already tried this problem. Not looping.", 429);
    busy = true;
    const id = `fix-${now().toString(36)}`;
    const snapDir = path.join(root, id);
    const entry = { id, at: now(), scope: scope.name, target: scope.target ?? null, title, agent: c.agent, actor: actor ?? "auto", incident: incident ?? null, state: "running", changed: [], summary: "" };
    saveHistory([entry, ...history()]);
    const ref = {};
    const job = jobs.start({ title: `Auto-fix: ${title}`, actor: actor ?? "auto-fix" }, async (ctx) => {
      try {
        const evidence = await scope.evidence();
        ctx.log("Taking a snapshot of the config and text files first…");
        const index = await snapshot(scope.dir, snapDir);
        Object.defineProperty(index, "__dir", { value: snapDir, enumerable: false });
        const task = `You are repairing: ${title}.\nThe current folder is where the problem lives.\n\n${RULES}\n\nWhat Console found:\n${evidence}`;
        const { cmd, args, env } = await agentArgv(c, task, scope.dir);
        let out = "";
        try {
          const r = await ctx.exec(cmd, args, { cwd: scope.dir, env: { PATH: `${toolsBin()}:${process.env.PATH}`, ...env }, label: `${agents[c.agent]?.label ?? "custom agent"} (fixing)` });
          void r;
          out = String(jobs.get(ref.id)?.log ?? "").trim().split("\n").slice(-12).join("\n").slice(-1200); // the agent's closing words
        } catch (e) { out = `The agent stopped with an error: ${e.message}`.slice(0, 600); }
        const changed = await diffAgainst(scope.dir, index);
        patchEntry(id, { changed, summary: out });
        if (!changed.length) { patchEntry(id, { state: "nochange" }); ctx.log("The agent changed nothing."); return { id }; }
        ctx.log(`Changed: ${changed.map((x) => `${x.file} (${x.change})`).join(", ")}`);
        const v = await scope.verify(changed);
        if (v.ok) { await scope.onFixed?.(); patchEntry(id, { state: "fixed", verify: v.detail }); ctx.log(`Verified: ${v.detail}`); return { id }; }
        ctx.log(`Didn't work (${v.detail}). Putting everything back.`);
        await restore(scope.dir, snapDir);
        await scope.after?.();
        patchEntry(id, { state: "reverted", verify: v.detail });
        return { id };
      } catch (e) {
        patchEntry(id, { state: "failed", summary: e.message });
        throw e;
      } finally { busy = false; }
    });
    ref.id = job.id;
    return { id, jobId: job.id };
  }

  async function undo(id) {
    const h = history().find((x) => x.id === id);
    if (!h) throw new AutoFixError("No such fix", 404);
    if (h.state !== "fixed") throw new AutoFixError("Only a fix that was applied can be undone");
    const scope = await scopes.resolve(h.scope, h);
    await restore(scope.dir, path.join(root, id));
    await scope.after?.();
    patchEntry(id, { state: "undone" });
  }

  return { status, configure, fix, undo, scopes, busy: () => busy };
}

async function defaultWhich(bin) {
  if (path.isAbsolute(bin)) return existsSync(bin);
  const { spawnSync } = await import("node:child_process");
  return spawnSync("sh", ["-c", `command -v ${bin.replace(/[^\w.-]/g, "")}`]).status === 0;
}
