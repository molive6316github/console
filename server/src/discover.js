import { promises as fs, existsSync, readdirSync, lstatSync, readlinkSync, realpathSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { run as realRun } from "./drivers/exec.js";
import { listServers, ID } from "./db.js";
import { filesRootOf } from "./runtime.js";

export class DiscoverError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const IMAGE = /^[a-zA-Z0-9][a-zA-Z0-9_.\/:@-]{0,255}$/;
const UNIT = /^[a-zA-Z0-9][a-zA-Z0-9:_.@-]{0,120}\.service$/;

// tmux turns control characters (tabs included) into "_" when it isn't writing to a terminal, so use a printable separator.
const SEP = "|~|";

// ---- parsers (pure; tested on sample output) ------------------------------------------------
export function parseTmux(sessionsText, panesText) {
  const panes = new Map();
  for (const line of panesText.split("\n")) {
    const [name, cwd, cmd] = line.split(SEP);
    if (name && !panes.has(name)) panes.set(name, { cwd: cwd || null, command: (cmd ?? "").replace(/^"(.*)"$/, "$1") || null });
  }
  return sessionsText
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, created, attached, windows] = line.split(SEP);
      return { name, created: Number(created) * 1000 || null, attached: Number(attached) > 0, windows: Number(windows) || 1, ...(panes.get(name) ?? { cwd: null, command: null }) };
    });
}

export function parseJsonLines(text) {
  return text
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function parsePs(text, { selfPid = -1, minRssKB = 20_000, limit = 30 } = {}) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const [, pid, user, etimes, rss, args] = m;
    if (Number(pid) === selfPid || args.startsWith("[") || /^ps -eo/.test(args)) continue; // kernel threads, ourselves
    if (Number(rss) < minRssKB) continue;
    out.push({ pid: Number(pid), user, ageSec: Number(etimes), rssKB: Number(rss), command: args.length > 200 ? args.slice(0, 200) + "…" : args });
    if (out.length >= limit) break;
  }
  return out;
}

export function parseSystemdShow(text) {
  return text
    .split(/\n\s*\n/)
    .map((block) => Object.fromEntries(block.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])))
    .filter((o) => o.Id);
}

const MARKERS = {
  "server.properties": "minecraft",
  "eula.txt": "minecraft",
  "docker-compose.yml": "docker compose",
  "docker-compose.yaml": "docker compose",
  "package.json": "node",
  "requirements.txt": "python",
  ".git": "git repo",
};

// Last line of defence before a recursive delete, independent of everything above it: never "/", never a
// top-level system folder (/etc, /usr, /home, /var ...), and never a path that doesn't resolve to itself.
export function assertSafeToRemove(p) {
  let rp;
  try {
    rp = realpathSync(p);
  } catch {
    throw new DiscoverError("Refusing to delete that path", 409);
  }
  if (rp !== path.resolve(p) || path.dirname(rp) === path.parse(rp).root || rp === path.parse(rp).root) {
    throw new DiscoverError("Refusing to delete that path", 409);
  }
}

const under = (child, parent) => child === parent || child.startsWith(parent + path.sep);
const unreadable = (e) => e?.code === "EACCES" || e?.code === "EPERM";

export function createDiscover({ db, dataDir, selfDir, run = realRun, extraRoots = [], procDir = "/proc", homeDir = "/home", baseRoots = ["/srv", "/opt"], uid = process.getuid?.() ?? 0 }) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const self = real(selfDir);
  const data = real(dataDir);

  const managed = () => listServers(db);
  const rootOf = (s) => filesRootOf(s);

  // ---- tmux -----------------------------------------------------------------------------
  async function tmux() {
    const sess = await run("tmux", ["list-sessions", "-F", ["#{session_name}", "#{session_created}", "#{session_attached}", "#{session_windows}"].join(SEP)]);
    if (/ENOENT/.test(sess.stderr)) return { ok: false, reason: "tmux isn't installed on this machine" };
    let sessions = [];
    if (sess.code === 0) {
      const panes = await run("tmux", ["list-panes", "-a", "-F", ["#{session_name}", "#{pane_current_path}", "#{pane_start_command}"].join(SEP)]);
      sessions = parseTmux(sess.stdout, panes.stdout);
    }
    const byName = new Map(managed().filter((s) => s.type === "tmux").map((s) => [s.target.session, s.id]));
    sessions = sessions.map((s) => ({ ...s, managedBy: byName.get(s.name) ?? null }));

    // tmux sessions belong to the Linux user that started them. List the other users' sockets so you know what Console can't see.
    const passwd = new Map();
    try {
      for (const l of readFileSync("/etc/passwd", "utf8").split("\n")) {
        const f = l.split(":");
        if (f[2]) passwd.set(Number(f[2]), f[0]);
      }
    } catch { /* not Linux */ }
    const others = [];
    try {
      for (const d of readdirSync("/tmp")) {
        const m = /^tmux-(\d+)$/.exec(d);
        if (!m || Number(m[1]) === uid) continue;
        const sock = `/tmp/tmux-${m[1]}/default`;
        if (!existsSync(sock)) continue;
        const r = await run("tmux", ["-S", sock, "list-sessions", "-F", "#{session_name}"]);
        others.push({ user: passwd.get(Number(m[1])) ?? `uid ${m[1]}`, readable: r.code === 0, sessions: r.code === 0 ? r.stdout.split("\n").filter(Boolean) : [] });
      }
    } catch { /* /tmp unreadable */ }
    return { ok: true, sessions, others, runningAs: passwd.get(uid) ?? `uid ${uid}` };
  }

  // ---- docker ---------------------------------------------------------------------------
  const dockerFail = (r) =>
    /ENOENT/.test(r.stderr) ? "Docker isn't installed on this machine"
    : /permission denied/i.test(r.stderr) ? "Console's user can't talk to Docker. Run: sudo usermod -aG docker console && sudo systemctl restart console"
    : /cannot connect|failed to connect to the docker api|docker\.sock|is the docker daemon running/i.test(r.stderr) ? "The Docker service isn't running"
    : r.stderr.trim().split("\n")[0] || "Docker failed";

  async function docker() {
    const c = await run("docker", ["ps", "-a", "--format", "{{json .}}"], { timeout: 15_000 });
    if (c.code !== 0) return { ok: false, reason: dockerFail(c) };
    const [img, df] = await Promise.all([
      run("docker", ["images", "--format", "{{json .}}"], { timeout: 15_000 }),
      run("docker", ["system", "df", "--format", "{{json .}}"], { timeout: 20_000 }),
    ]);
    const byName = new Map(managed().filter((s) => s.type === "docker").map((s) => [s.target.container, s.id]));
    const usedImages = new Set();
    const withTag = (ref) => (/[:@]/.test(ref.split("/").pop()) ? ref : `${ref}:latest`); // "nginx" means "nginx:latest"
    const containers = parseJsonLines(c.stdout).map((x) => {
      usedImages.add(x.Image);
      usedImages.add(withTag(x.Image));
      return { id: x.ID, name: x.Names, image: x.Image, state: x.State, status: x.Status, created: x.CreatedAt, managedBy: byName.get(x.Names) ?? null };
    });
    const images = parseJsonLines(img.stdout).map((x) => {
      const ref = x.Repository === "<none>" ? x.ID : `${x.Repository}:${x.Tag}`;
      return { id: x.ID, ref, size: x.Size, created: x.CreatedSince, dangling: x.Repository === "<none>", inUse: usedImages.has(ref) || usedImages.has(x.ID) };
    });
    return { ok: true, containers, images, df: parseJsonLines(df.stdout).map((x) => ({ type: x.Type, count: x.TotalCount, size: x.Size, reclaimable: x.Reclaimable })) };
  }

  // ---- systemd --------------------------------------------------------------------------
  async function systemd() {
    const list = await run("systemctl", ["list-units", "--type=service", "--state=running", "--no-legend", "--plain", "--no-pager"]);
    if (/ENOENT/.test(list.stderr)) return { ok: false, reason: "systemd isn't available here" };
    const userUnits = new Set();
    try {
      for (const f of readdirSync("/etc/systemd/system")) {
        if (f.endsWith(".service") && lstatSync(path.join("/etc/systemd/system", f)).isFile()) userUnits.add(f);
      }
    } catch { /* ignore */ }
    const running = list.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((u) => UNIT.test(u ?? ""));
    const units = [...new Set([...userUnits, ...running])].filter((u) => UNIT.test(u));
    if (!units.length) return { ok: true, units: [] };
    const show = await run("systemctl", ["show", "--property=Id,Description,ActiveState,SubState", ...units], { timeout: 15_000 });
    const byUnit = new Map(managed().filter((s) => s.type === "systemd" && s.target.host === "local").map((s) => [s.target.unit, s.id]));
    return {
      ok: true,
      units: parseSystemdShow(show.stdout).map((u) => ({
        unit: u.Id, description: u.Description, active: u.ActiveState, sub: u.SubState,
        vendor: !userUnits.has(u.Id), self: u.Id === "console.service", managedBy: byUnit.get(u.Id) ?? null,
      })),
    };
  }

  // ---- processes ------------------------------------------------------------------------
  async function processes() {
    const r = await run("ps", ["-eo", "pid=,user=,etimes=,rss=,args=", "--sort=-rss"]);
    if (r.code !== 0) return { ok: false, reason: r.stderr.trim() || "ps failed" };
    return { ok: true, processes: parsePs(r.stdout, { selfPid: process.pid }) };
  }

  // ---- folders --------------------------------------------------------------------------
  function scanRoots() {
    const roots = [...baseRoots, ...extraRoots];
    try {
      for (const u of readdirSync(homeDir)) roots.push(path.join(homeDir, u));
    } catch { /* no /home */ }
    return [...new Set(roots)].filter((r) => existsSync(r));
  }

  // The only folders Console will ever offer to delete: real (non-symlink) directories directly inside a scan root.
  function candidates() {
    const out = [];
    for (const root of scanRoots()) {
      let names;
      try {
        names = readdirSync(root);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const p = path.join(root, name);
        try {
          const st = lstatSync(p);
          if (st.isDirectory() && !st.isSymbolicLink()) out.push({ path: p, name, root, mtime: Math.floor(st.mtimeMs) });
        } catch { /* vanished */ }
      }
    }
    return out;
  }

  function protectedReason(p) {
    const rp = real(p);
    if (under(self, rp)) return "This is Console itself";
    if (under(rp, data) || under(data, rp)) return "This holds Console's database and backups";
    for (const r of scanRoots()) if (rp === real(r)) return "This is a scan root";
    for (const s of managed()) {
      const root = rootOf(s);
      if (root && (under(real(root), rp) || under(rp, real(root)))) return `Used by "${s.name}". Remove that server from Console first.`;
    }
    return null;
  }

  async function sizeKB(p) {
    const r = await run("du", ["-sk", "-x", "--", p], { timeout: 20_000 });
    const m = /^(\d+)/.exec(r.stdout);
    return { kb: m ? Number(m[1]) : null, partial: r.code !== 0 };
  }

  async function folders() {
    const list = candidates().slice(0, 80);
    const results = [];
    let i = 0;
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        while (i < list.length) {
          const c = list[i++];
          const { kb, partial } = await sizeKB(c.path);
          const tags = new Set();
          try {
            const names = readdirSync(c.path);
            for (const n of names) {
              if (MARKERS[n]) tags.add(MARKERS[n]);
              if (n.endsWith(".jar")) tags.add("java");
            }
          } catch { tags.add("unreadable"); }
          const reason = protectedReason(c.path);
          const owner = managed().find((s) => rootOf(s) && under(real(rootOf(s)), real(c.path)) );
          results.push({ ...c, sizeKB: kb, partial, tags: [...tags], protected: reason, managedBy: owner?.id ?? null });
        }
      })
    );
    results.sort((a, b) => (b.sizeKB ?? -1) - (a.sizeKB ?? -1));
    let disk = null;
    try {
      const s = statfsSync("/");
      disk = { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
    } catch { /* ignore */ }
    return { ok: true, folders: results, roots: scanRoots(), disk };
  }

  // Is anything running from inside this folder? (a process whose working directory is in it, or a tmux session there)
  function inUseBy(p) {
    const rp = real(p);
    try {
      for (const pid of readdirSync(procDir)) {
        if (!/^\d+$/.test(pid) || Number(pid) === process.pid) continue;
        try {
          const cwd = readlinkSync(path.join(procDir, pid, "cwd"));
          if (under(cwd, rp)) {
            let cmd = "";
            try { cmd = readFileSync(path.join(procDir, pid, "cmdline"), "utf8").replace(/\0/g, " ").trim().slice(0, 80); } catch { /* ignore */ }
            return `process ${pid}${cmd ? ` (${cmd})` : ""}`;
          }
        } catch { /* not ours to read, or gone */ }
      }
    } catch { /* no /proc */ }
    return null;
  }

  async function deleteFolder({ path: p, confirm, archive }) {
    if (typeof p !== "string") throw new DiscoverError("Pick a folder");
    const c = candidates().find((x) => x.path === p);
    if (!c) throw new DiscoverError("That isn't one of the folders Console scanned", 404);
    const st = lstatSync(p);
    if (st.isSymbolicLink() || !st.isDirectory()) throw new DiscoverError("Not a plain folder");
    const why = protectedReason(p);
    if (why) throw new DiscoverError(why, 409);
    if (confirm !== c.name) throw new DiscoverError(`To confirm, type the folder name exactly: ${c.name}`);
    const busy = inUseBy(p);
    if (busy) throw new DiscoverError(`Something is still running from this folder: ${busy}. Stop it first.`, 409);
    const { kb } = await sizeKB(p);
    let archived = null;
    if (archive) {
      const dir = path.join(dataDir, "backups", "_deleted");
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const name = `${c.name.replace(/[^a-zA-Z0-9_.-]/g, "_")}-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.tar.gz`;
      const out = path.join(dir, name);
      const r = await run("tar", ["-czf", out, "-C", path.dirname(p), "--", c.name], { timeout: 20 * 60_000 });
      if (r.code > 1) {
        await fs.rm(out, { force: true });
        throw new DiscoverError(`Couldn't make the safety copy, so nothing was deleted: ${r.stderr.trim().split("\n").pop()}`, 500);
      }
      archived = name;
    }
    assertSafeToRemove(p);
    try {
      await fs.rm(p, { recursive: true, force: false });
    } catch (e) {
      throw new DiscoverError(unreadable(e) ? `Deleted part of it, but some files belong to another user and Console can't remove them: ${e.path ?? ""}` : `Couldn't delete: ${e.message}`, 500);
    }
    return { ok: true, freedKB: kb, archived };
  }

  // ---- tmux / docker actions ------------------------------------------------------------
  async function killTmux(name) {
    if (typeof name !== "string" || !SESSION.test(name)) throw new DiscoverError("Bad session name");
    const m = managed().find((s) => s.type === "tmux" && s.target.session === name);
    if (m) throw new DiscoverError(`That's "${m.name}" in Console. Use its Stop button (it stops gracefully).`, 409);
    const r = await run("tmux", ["kill-session", "-t", `=${name}`]);
    if (r.code !== 0) throw new DiscoverError(r.stderr.trim() || "Couldn't kill it", 500);
    return { ok: true };
  }

  async function dockerRemove({ kind, id, force }) {
    if (kind === "container") {
      if (typeof id !== "string" || !CONTAINER.test(id)) throw new DiscoverError("Bad container");
      const m = managed().find((s) => s.type === "docker" && (s.target.container === id));
      if (m) throw new DiscoverError(`That's "${m.name}" in Console. Remove it from Console first.`, 409);
      const r = await run("docker", ["rm", ...(force ? ["-f"] : []), id], { timeout: 60_000 });
      if (r.code !== 0) throw new DiscoverError(r.stderr.trim().split("\n")[0] || "docker rm failed", 500);
      return { ok: true };
    }
    if (kind === "image") {
      if (typeof id !== "string" || !IMAGE.test(id)) throw new DiscoverError("Bad image");
      const r = await run("docker", ["rmi", id], { timeout: 60_000 });
      if (r.code !== 0) throw new DiscoverError(r.stderr.trim().split("\n")[0] || "docker rmi failed", 500);
      return { ok: true };
    }
    throw new DiscoverError("Unknown kind");
  }

  // Only the safe prunes: stopped containers and untagged ("dangling") images. Never volumes: that's your data.
  async function dockerPrune(what) {
    const args = what === "containers" ? ["container", "prune", "-f"] : what === "images" ? ["image", "prune", "-f"] : null;
    if (!args) throw new DiscoverError("Unknown prune");
    const r = await run("docker", args, { timeout: 120_000 });
    if (r.code !== 0) throw new DiscoverError(r.stderr.trim().split("\n")[0] || "prune failed", 500);
    const m = /Total reclaimed space:\s*(.+)/.exec(r.stdout);
    return { ok: true, reclaimed: m ? m[1].trim() : "0B" };
  }

  // ---- Console's own leftovers ----------------------------------------------------------
  async function cleanup() {
    const base = path.join(dataDir, "backups");
    const known = new Set(managed().map((s) => s.id));
    const orphans = [];
    const archives = [];
    if (existsSync(base)) {
      for (const name of readdirSync(base)) {
        const dir = path.join(base, name);
        if (name === "_deleted") {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith(".tar.gz")) continue;
            const st = await fs.stat(path.join(dir, f));
            archives.push({ name: f, size: st.size, created: Math.floor(st.mtimeMs) });
          }
        } else if (ID.test(name) && !known.has(name)) {
          const { kb } = await sizeKB(dir);
          orphans.push({ id: name, sizeKB: kb });
        }
      }
    }
    return { ok: true, orphans, archives };
  }

  async function cleanupDelete({ kind, name }) {
    const base = path.join(dataDir, "backups");
    if (kind === "orphan") {
      if (typeof name !== "string" || !ID.test(name)) throw new DiscoverError("Bad name");
      if (managed().some((s) => s.id === name)) throw new DiscoverError("That server still exists", 409);
      await fs.rm(path.join(base, name), { recursive: true, force: true });
      return { ok: true };
    }
    if (kind === "archive") {
      if (typeof name !== "string" || !/^[a-zA-Z0-9_.-]+\.tar\.gz$/.test(name)) throw new DiscoverError("Bad name");
      await fs.rm(path.join(base, "_deleted", name), { force: true });
      return { ok: true };
    }
    throw new DiscoverError("Unknown kind");
  }

  return { tmux, docker, systemd, processes, folders, cleanup, cleanupDelete, deleteFolder, killTmux, dockerRemove, dockerPrune, candidates, protectedReason };
}
