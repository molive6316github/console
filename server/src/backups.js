import { promises as fs, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { run } from "./drivers/exec.js";

export const BACKUP_NAME = /^\d{8}T\d{6}Z\.tar\.gz$/;

const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function createBackups(dataDir) {
  const dirFor = (serverId) => path.join(dataDir, "backups", serverId);

  async function list(serverId) {
    const dir = dirFor(serverId);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of await fs.readdir(dir)) {
      if (!BACKUP_NAME.test(name)) continue;
      const st = await fs.stat(path.join(dir, name));
      out.push({ name, size: st.size, created: Math.floor(st.mtimeMs) });
    }
    return out.sort((a, b) => b.name.localeCompare(a.name));
  }

  async function prune(serverId, keep) {
    const all = await list(serverId);
    for (const b of all.slice(keep)) await fs.rm(path.join(dirFor(serverId), b.name), { force: true });
    return Math.max(0, all.length - keep);
  }

  // tar.gz of the server's files folder. For a game server, schedule it after a stop or a "save-all" so the files are consistent.
  async function create(serverId, root, { keep = 7, now = new Date() } = {}) {
    let rootReal;
    try {
      rootReal = realpathSync(root);
    } catch {
      throw new Error("The files folder doesn't exist on this machine");
    }
    const dir = dirFor(serverId);
    const dataReal = existsSync(dataDir) ? realpathSync(dataDir) : path.resolve(dataDir);
    if (dataReal === rootReal || dataReal.startsWith(rootReal + path.sep)) {
      throw new Error("The files folder contains Console's own data folder; refusing to back it up into itself");
    }
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${stamp(now)}.tar.gz`;
    const final = path.join(dir, name);
    const tmp = `${final}.partial`;
    const r = await run("tar", ["-czf", tmp, "-C", rootReal, "."], { timeout: 15 * 60_000 });
    // tar exits 1 for "file changed as we read it", which is normal for a live server; 2 is a real failure
    if (r.code > 1 || !existsSync(tmp)) {
      await fs.rm(tmp, { force: true });
      throw new Error(`tar failed: ${r.stderr.trim().split("\n").pop() || `exit ${r.code}`}`);
    }
    await fs.rename(tmp, final);
    await prune(serverId, keep);
    const st = await fs.stat(final);
    return { name, size: st.size };
  }

  function pathFor(serverId, name) {
    if (!BACKUP_NAME.test(name)) return null;
    const p = path.join(dirFor(serverId), name);
    return existsSync(p) ? p : null;
  }

  async function remove(serverId, name) {
    const p = pathFor(serverId, name);
    if (!p) return false;
    await fs.rm(p);
    return true;
  }

  return { list, create, pathFor, remove, prune };
}
