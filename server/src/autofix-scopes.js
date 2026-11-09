import path from "node:path";
import { existsSync } from "node:fs";
import { readManifest } from "./cplugins.js";
import { mcRoot } from "./mc/index.js";
import { getServer } from "./db.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d) => `${d.checks.map((c) => `- [${c.state}] ${c.label}: ${c.detail}`).join("\n")}\n\nLast output:\n${d.log || "(nothing)"}`;

// What each kind of problem looks like to the fixer: where it may edit, what it's told, and how we know it worked.
export function createScopes({ db, mc, runtime, diagnose, pluginHost, repoRoot, run, restartConsole = null, waitMs = 150_000, pollMs = 3000 }) {
  const check = async (dir, files) => {
    for (const f of files.filter((x) => /\.(js|mjs)$/.test(x.file) && x.change !== "deleted")) {
      const r = await run(process.execPath, ["--check", path.join(dir, f.file)], { timeout: 15_000 });
      if (r.code !== 0) return { ok: false, detail: `${f.file} has a syntax error: ${r.stderr.trim().split("\n")[0]}` };
    }
    return { ok: true, detail: "changed files pass a syntax check" };
  };

  async function minecraft(serverId, note) {
    const server = getServer(db, serverId);
    if (!server) throw new Error("No such server");
    const dir = mcRoot(server);
    return {
      name: "minecraft", target: serverId, dir,
      evidence: async () => `${note ? `Note: ${note}\n` : ""}${fmt(await diagnose.diagnose(server))}`,
      verify: async () => {
        // Start (or restart) it and give it time to answer players.
        const live = await mc.liveStatus(server).catch(() => null);
        await runtime.perform(server, live?.process === "up" ? "restart" : "start", "auto-fix").catch(() => {});
        const end = Date.now() + waitMs;
        while (Date.now() < end) {
          await sleep(pollMs);
          const s = await mc.liveStatus(server).catch(() => null);
          if (s?.state === "online") return { ok: true, detail: "the server started and is answering players" };
          if (s?.state === "crashed") return { ok: false, detail: "it crashed again after the change" };
        }
        return { ok: false, detail: "it didn't come online in time" };
      },
      after: async () => { await runtime.perform(server, "stop", "auto-fix").catch(() => {}); },
    };
  }

  async function plugins(pluginId, note) {
    const m = pluginHost.discover().get(pluginId);
    if (!m || m.builtin) throw new Error("Only plugins you installed can be fixed here. Built-in ones ship with Console.");
    return {
      name: "plugins", target: pluginId, dir: m.dir,
      evidence: async () => `Console plugin "${m.id}". ${note ?? ""}\nManifest/plugin error: ${m.error ?? "none"}\nSee PLUGINS.md in the Console repo for the plugin format if needed.`,
      verify: async (changed) => {
        const mm = readManifest(m.dir, false);
        if (!mm || mm.error) return { ok: false, detail: mm?.error ?? "manifest.json is broken" };
        if (!existsSync(path.join(m.dir, mm.entry))) return { ok: false, detail: `${mm.entry} is missing` };
        return check(m.dir, changed ?? [{ file: mm.entry, change: "edited" }]);
      },
    };
  }

  async function consoleItself(note) {
    return {
      name: "console", dir: repoRoot,
      evidence: async () => `Console (this panel's own code). ${note ?? "Something in Console is failing."}\nOnly edit under server/, web/src/ and bin/. A later Console update will replace your change with the official release.`,
      verify: async (changed) => check(repoRoot, changed),
      onFixed: async () => { await restartConsole?.(); },
    };
  }

  async function link(note) {
    const dir = path.join(repoRoot, "link");
    return {
      name: "link", dir,
      evidence: async () => `Console Link (hub/ is a Node service, plugin/ is a Java Paper plugin that can't be compiled here). ${note ?? ""}\nRun nothing; edit only.`,
      verify: async (changed) => {
        const syntax = await check(dir, changed);
        if (!syntax.ok) return syntax;
        const t = await run(process.execPath, ["--test", "hub/test/hub.test.js"], { cwd: dir, timeout: 60_000 });
        return t.code === 0 ? { ok: true, detail: "the hub tests pass" } : { ok: false, detail: "the hub tests fail" };
      },
    };
  }

  const resolve = (name, h = {}) => ({ minecraft: () => minecraft(h.target, null), plugins: () => plugins(h.target, null), console: () => consoleItself(null), link: () => link(null) })[name]?.();
  return { minecraft, plugins, console: consoleItself, link, resolve };
}
