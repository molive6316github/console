import { listServers, getSetting, audit } from "./db.js";
import { parseCron, matches, partsIn, validTimezone, nextRun } from "./cron.js";
import { ActionError } from "./runtime.js";

export const SCHEDULE_ACTIONS = ["start", "stop", "restart", "backup", "command", "mc-backup", "mc-github-config", "mc-github-world"]
export const MC_ACTIONS = ["mc-backup", "mc-github-config", "mc-github-world"];

export function defaultTimezone(db) {
  const saved = getSetting(db, "timezone");
  if (saved && validTimezone(saved)) return saved;
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// Runs due schedules. Checked every 20s; each schedule fires at most once per minute.
// If Console was down at the scheduled minute, that run is skipped (it doesn't catch up).
export function createScheduler({ db, runtime, now = () => Date.now(), runMc = null }) {
  async function tick(at = now()) {
    const minute = Math.floor(at / 60000);
    const tz = defaultTimezone(db);
    const parts = partsIn(new Date(at), tz);
    const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1").all();
    const servers = new Map(listServers(db).map((s) => [s.id, s]));
    const jobs = [];
    for (const row of rows) {
      if (row.last_minute === minute) continue;
      let due = false;
      try {
        due = matches(parseCron(row.cron), parts);
      } catch {
        continue;
      }
      if (!due) continue;
      db.prepare("UPDATE schedules SET last_minute = ? WHERE id = ?").run(minute, row.id);
      jobs.push(runOne(row, servers.get(row.server_id)));
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  async function runOne(row, server) {
    const actor = `schedule #${row.id}`;
    let status = "ok";
    let detail = null;
    if (!server) {
      status = "failed";
      detail = "server no longer exists";
    } else {
      try {
        if (MC_ACTIONS.includes(row.action)) {
          if (!runMc) throw new Error("Minecraft tools aren't available");
          await runMc(server, row.action, actor);
        } else await runtime.perform(server, row.action, actor, row.arg ?? undefined);
      } catch (e) {
        status = e instanceof ActionError && e.status === 409 ? "skipped" : "failed";
        detail = e.message;
      }
    }
    db.prepare("UPDATE schedules SET last_status = ?, last_detail = ? WHERE id = ?").run(status, detail, row.id);
    if (status !== "ok") audit(db, { username: actor, serverId: row.server_id, action: row.action, ok: false, detail });
    return status;
  }

  let timer = null;
  return {
    tick,
    runOne,
    start() {
      timer = setInterval(() => tick().catch(() => {}), 20_000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
    nextRun: (row) => {
      try {
        return nextRun(row.cron, defaultTimezone(db), now());
      } catch {
        return null;
      }
    },
  };
}
