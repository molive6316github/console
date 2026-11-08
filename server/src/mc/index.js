import { promises as fs, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { getDriver } from "../drivers/index.js";
import { filesRootOf } from "../runtime.js";
import { McError, view, apply } from "./props.js";
import { buildCommand, parseList } from "./players.js";
import { createPlugins } from "./plugins.js";
import { pauseSaves } from "./savehooks.js";
import { restoreBackup, resetWorld } from "./worlds.js";
import { pushConfig, pushWorld, repoOf } from "./github.js";
import { ping } from "./slp.js";
import { createVersions } from "./versions.js";
import { parse } from "./props.js";
import { tokenSecrets } from "../gitutil.js";
import { BACKUP_NAME } from "../backups.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The folder, if (and only if) it is a Minecraft server: it has a server.properties.
export function mcRoot(server) {
  const root = filesRootOf(server);
  if (!root) return null;
  try {
    return existsSync(path.join(root, "server.properties")) ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

export function mcKind(root) {
  if (existsSync(path.join(root, "mods"))) return "mods";
  return "plugins";
}

async function readJson(file) {
  try {
    const v = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function createMc({ saveMeta = () => {}, saveTarget = () => {}, validateTarget = (_t, x) => x, run = async () => ({ code: 1, stdout: "", stderr: "" }), versionDeps = {}, runtime, listWaitMs = 900, fetchImpl = fetch, getToken, getMeta, jobs, getJoin = () => ({}), pingImpl = ping, cfgGet = () => null, cfgSet = () => {}, dataDir = "/tmp/console-mc", saveWaitMs = 30_000, afterBackup = null }) {
  const plugins = createPlugins({ fetchImpl, getToken, getMeta });
  const rootKind = (server) => {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    return { root, kind: mcKind(root) };
  };
  async function getProps(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server (no server.properties in its folder)", 404);
    return view(await fs.readFile(path.join(root, "server.properties"), "utf8"));
  }

  async function setProps(server, changes) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const file = path.join(root, "server.properties");
    const before = await fs.readFile(file, "utf8");
    const { text, changed } = apply(before, changes);
    if (!changed) return { changed: 0 };
    await fs.writeFile(`${file}.console-bak`, before);
    const tmp = `${file}.console-tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
    return { changed };
  }

  // Asks the running server for its player list and reads the answer back from its console.
  async function players(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const driver = getDriver(server.type);
    const status = await runtime.status(server).catch(() => "unknown");
    const lists = {
      whitelist: (await readJson(path.join(root, "whitelist.json"))).map((p) => p.name).filter(Boolean),
      ops: (await readJson(path.join(root, "ops.json"))).map((p) => p.name).filter(Boolean),
      banned: (await readJson(path.join(root, "banned-players.json"))).map((p) => ({ name: p.name, reason: p.reason })).filter((p) => p.name),
    };
    if (status !== "up" || !driver.send) return { up: false, ...lists };
    try {
      await driver.send(server.target, "list", { id: server.id });
      await sleep(listWaitMs);
      const out = await driver.logs(server.target, 40);
      return { up: true, ...(parseList(out) ?? { count: null, max: null, players: [] }), ...lists };
    } catch (e) {
      return { up: true, count: null, max: null, players: [], error: e.message, ...lists };
    }
  }

  async function act(server, actor, action, body) {
    if (!mcRoot(server)) throw new McError("This isn't a Minecraft server", 404);
    const cmd = buildCommand(action, body);
    await runtime.perform(server, "command", actor, cmd);
    return { ok: true, command: cmd };
  }

  // ---- backups that don't corrupt a running world ----
  const pauser = (server, root) => () => pauseSaves(server, root, { status: (x) => runtime.status(x), waitMs: saveWaitMs });
  async function safeBackup(server, actor) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    if (runtime.busy.has(server.id)) throw new McError("Another action is already running on this server", 409);
    const resume = await pauser(server, root)();
    let result;
    try {
      result = await runtime.perform(server, "backup", actor);
    } finally {
      await resume?.();
    }
    // The copy to other storage happens after the world is saving again, so a slow upload never freezes the game.
    if (afterBackup && result?.name) {
      try { await afterBackup(server, result); } catch (e) { throw new McError(`Backup saved on this machine, but copying it off-box failed: ${e.message}`, 502); }
    }
    return result;
  }

  const mustBeStopped = async (server) => {
    if (runtime.busy.has(server.id)) throw new McError("Another action is already running on this server", 409);
    if ((await runtime.status(server).catch(() => "unknown")) !== "down") throw new McError("Stop the server first. This can't be done while it's running.", 409);
  };
  const needConfirm = (server, confirm) => {
    if (confirm !== server.id) throw new McError(`Type the server ID (${server.id}) to confirm`, 400);
  };

  const versions = createVersions({ jobs, fetchImpl, runtime, getMeta, saveMeta, saveTarget, validateTarget, run, mustBeStopped, needConfirm, ...versionDeps });
  async function switchVersion(server, body, actor) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    return versions.switchTo(server, root, body ?? {}, actor);
  }

  async function restore(server, name, confirm) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    needConfirm(server, confirm);
    if (!BACKUP_NAME.test(String(name))) throw new McError("No such backup", 404);
    const file = runtime.backups.pathFor(server.id, name);
    if (!file) throw new McError("No such backup", 404);
    await mustBeStopped(server);
    runtime.busy.add(server.id);
    try {
      return await restoreBackup({ root, file });
    } finally {
      runtime.busy.delete(server.id);
    }
  }

  async function reset(server, confirm) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    needConfirm(server, confirm);
    await mustBeStopped(server);
    runtime.busy.add(server.id);
    try {
      return await resetWorld({ root });
    } finally {
      runtime.busy.delete(server.id);
    }
  }

  async function portOf(server) {
    const root = mcRoot(server);
    if (!root) return 25565;
    try {
      return Number(parse(await fs.readFile(path.join(root, "server.properties"), "utf8")).values["server-port"]) || 25565;
    } catch { return 25565; }
  }

  // Asks the console for TPS and returns the last lines. Paper/Purpur: `tps`. Vanilla: `tick query`.
  async function readTps(server, flavor) {
    const driver = getDriver(server.type);
    if (!driver.send || !driver.logs) return null;
    await driver.send(server.target, flavor === "vanilla" ? "tick query" : "tps", { id: server.id });
    await sleep(listWaitMs);
    return driver.logs(server.target, 30);
  }

  // What players type to join: your domain (no port when an SRV record covers it), else the public IP, with :port when it isn't 25565.
  function joinInfo(port) {
    const j = getJoin() ?? {};
    const host = j.domain || j.ip || "";
    const showPort = port !== 25565 && !(j.domain && j.srv);
    return { host, port, address: host ? (showPort ? `${host}:${port}` : host) : "", domain: j.domain || "", srv: Boolean(j.srv) };
  }

  // Live status without touching the console: asks the server the same question the game's server list does.
  async function liveStatus(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const props = parse(await fs.readFile(path.join(root, "server.properties"), "utf8")).values;
    const port = Number(props["server-port"]) || 25565;
    const up = (await runtime.status(server).catch(() => "unknown")) === "up";
    const r = up ? await pingImpl("127.0.0.1", port) : { online: false };
    return { process: up ? "up" : "down", ...r, port, level: props["level-name"] || "world", ...joinInfo(port), configuredMotd: String(props.motd ?? "").replace(/§./g, "") };
  }

  // ---- GitHub sync ----
  const cfgOf = (server) => ({ repo: "", keep: 5, ...(cfgGet(server.id) ?? {}) });
  const gh = {
    get: (server) => cfgOf(server),
    set: (server, { repo, keep }) => {
      const next = cfgOf(server);
      if (repo !== undefined) {
        if (repo !== "") repoOf(repo);
        next.repo = String(repo).trim();
      }
      if (keep !== undefined) {
        const k = Number(keep);
        if (!Number.isInteger(k) || k < 1 || k > 50) throw new McError("Keep must be a whole number from 1 to 50");
        next.keep = k;
      }
      cfgSet(server.id, next);
      return next;
    },
    pushConfig: (server, actor) => {
      const root = mcRoot(server);
      if (!root) throw new McError("This isn't a Minecraft server", 404);
      const cfg = cfgOf(server);
      if (!cfg.repo) throw new McError("Set the backup repo first");
      const token = getToken();
      if (!token) throw new McError("Save a GitHub token in Settings first");
      return jobs.start({ title: `Back up ${server.name} configs to GitHub`, actor, redact: tokenSecrets(token) }, (ctx) =>
        pushConfig({ ctx, root, serverId: server.id, repoInput: cfg.repo, token, workDir: path.join(dataDir, "mc-git", server.id) }));
    },
    pushWorld: (server, actor) => {
      const root = mcRoot(server);
      if (!root) throw new McError("This isn't a Minecraft server", 404);
      const cfg = cfgOf(server);
      if (!cfg.repo) throw new McError("Set the backup repo first");
      const token = getToken();
      if (!token) throw new McError("Save a GitHub token in Settings first");
      return jobs.start({ title: `Back up ${server.name} world to GitHub`, actor, redact: tokenSecrets(token) }, (ctx) =>
        pushWorld({ ctx, root, serverId: server.id, repoInput: cfg.repo, token, keep: cfg.keep, fetchImpl, tmpDir: path.join(dataDir, "mc-tmp"), pause: pauser(server, root) }));
    },
  };

  // Used by the scheduler: runs the same thing and waits for it to finish.
  async function scheduled(server, action, actor) {
    if (action === "mc-backup") return safeBackup(server, actor);
    const job = action === "mc-github-config" ? gh.pushConfig(server, actor) : action === "mc-github-world" ? gh.pushWorld(server, actor) : null;
    if (!job) throw new McError("Unknown action");
    for (;;) {
      const v = jobs.get(job.id);
      if (v.status === "done") return v.result;
      if (v.status === "failed") throw new McError(v.error ?? "failed");
      await sleep(500);
    }
  }

  return {
    getProps, setProps, players, act, liveStatus, joinInfo, safeBackup, switchVersion, portOf, readTps, runtimeStatus: (x) => runtime.status(x).catch(() => "unknown"), restore, reset, gh, scheduled,
    plugins: {
      kind: (server) => rootKind(server).kind,
      list: async (server) => { const { root, kind } = rootKind(server); return { kind, files: await plugins.list(root, kind) }; },
      toggle: async (server, file, enabled) => { const { root, kind } = rootKind(server); return plugins.setEnabled(root, kind, file, enabled === true); },
      remove: async (server, file) => { const { root, kind } = rootKind(server); return plugins.remove(root, kind, file); },
      modrinthSearch: (server, q, version) => { const { kind } = rootKind(server); return plugins.modrinthSearch({ kind, id: server.id, q, version }); },
      modrinthInstall: (server, slug, version) => { const { root, kind } = rootKind(server); return plugins.modrinthInstall({ root, kind, id: server.id, slug, version }); },
      catalog: (server, version) => { const { kind } = rootKind(server); return plugins.catalog({ kind, id: server.id, version }); },
      installMany: (server, slugs, version) => { const { root, kind } = rootKind(server); return plugins.installMany({ root, kind, id: server.id, slugs: Array.isArray(slugs) ? slugs.map(String) : [], version }); },
      githubRepos: (owner) => plugins.githubRepos(owner),
      githubReleases: (repo) => plugins.githubReleases(repo),
      githubInstall: (server, repo, assetId) => { const { root, kind } = rootKind(server); return plugins.githubInstall({ root, kind, repo, assetId }); },
    },
  };
}
