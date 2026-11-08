import { getDriver } from "./drivers/index.js";
import { audit, getSetting } from "./db.js";
import { createBackups } from "./backups.js";

export class ActionError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export const LIFECYCLE = ["start", "stop", "restart"];
export const ACTIONS = [...LIFECYCLE, "command", "backup"];

export function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Where a server's files live on THIS machine (editor + backups). Not available for remote servers.
export function filesRootOf(server) {
  const t = server.target ?? {};
  if (server.type === "systemd") return null;
  return t.filesRoot || (server.type === "tmux" ? t.cwd : null) || null;
}

export function capsOf(server) {
  const d = getDriver(server.type);
  return {
    logs: d.supports?.logs !== false,
    send: Boolean(d.send),
    files: Boolean(filesRootOf(server)),
    readOnly: Boolean(d.readOnly),
  };
}

// The one place that touches a server. The API, the scheduler and the monitor all go through here,
// so locking, auditing and "was this stop on purpose?" bookkeeping behave the same everywhere.
export function createRuntime({ db, dataDir, statusTimeoutMs = 6000, actionTimeoutMs = 120_000 }) {
  const busy = new Set();
  const backups = createBackups(dataDir);

  async function status(server) {
    const driver = getDriver(server.type);
    return withTimeout(Promise.resolve(driver.status(server.target, { id: server.id })), statusTimeoutMs, "status check");
  }

  // Set when the process exited by itself and its session was kept so the output can be read. null otherwise.
  async function exitInfo(server) {
    const driver = getDriver(server.type);
    if (!driver.exitInfo) return null;
    return withTimeout(Promise.resolve(driver.exitInfo(server.target, { id: server.id })), statusTimeoutMs, "exit check").catch(() => null);
  }

  function setExpected(id, expected) {
    db.prepare(
      `INSERT INTO server_state (server_id, expected, alerted, fails) VALUES (?, ?, 0, 0)
       ON CONFLICT(server_id) DO UPDATE SET expected = excluded.expected, alerted = 0, fails = 0`
    ).run(id, expected);
  }

  async function perform(server, action, actor, arg) {
    if (!ACTIONS.includes(action)) throw new ActionError("Unknown action", 400);
    const driver = getDriver(server.type);
    const log = (ok, detail) => audit(db, { username: actor, serverId: server.id, action, ok, detail });

    if (busy.has(server.id)) throw new ActionError("Another action is already running on this server", 409);

    if (action === "command") {
      if (!driver.send) throw new ActionError("This kind of server can't take commands", 400);
      try {
        await withTimeout(driver.send(server.target, arg, { id: server.id }), 15_000, "command");
        log(true, arg);
        return { ok: true };
      } catch (e) {
        log(false, `${arg} -> ${e.message}`);
        throw new ActionError(e.message, 500);
      }
    }

    if (action === "backup") {
      const root = filesRootOf(server);
      if (!root) throw new ActionError("This server has no local files folder to back up", 400);
      busy.add(server.id);
      try {
        const keep = Math.min(Math.max(parseInt(getSetting(db, "backup_keep", "7"), 10) || 7, 1), 50);
        const r = await backups.create(server.id, root, { keep });
        log(true, `${r.name} (${Math.round(r.size / 1024)} KB)`);
        return { ok: true, ...r };
      } catch (e) {
        log(false, e.message);
        throw new ActionError(e.message, 500);
      } finally {
        busy.delete(server.id);
      }
    }

    if (driver.readOnly) throw new ActionError("This server is read-only", 400);
    busy.add(server.id);
    try {
      await withTimeout(Promise.resolve(driver[action](server.target, { id: server.id })), actionTimeoutMs, action);
      setExpected(server.id, action === "stop" ? "down" : "up");
      log(true, null);
      const st = await status(server).catch(() => "unknown");
      return { ok: true, status: st };
    } catch (e) {
      log(false, e.message);
      throw new ActionError(e.message, 500);
    } finally {
      busy.delete(server.id);
    }
  }

  return { perform, status, exitInfo, busy, backups, setExpected };
}
