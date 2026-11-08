import { getDriver } from "./drivers/index.js";
import { listServers } from "./db.js";
import { withTimeout } from "./runtime.js";
import { createSampler } from "./hostmetrics.js";

const DAY = 86_400_000;
const KEEP_MS = 7 * DAY;
const CONFIRM_FAILS = 2; // consecutive "down" checks before an alert: one blip isn't an outage

const ago = (ms) => {
  const m = Math.round(ms / 60000);
  if (m < 1) return "under a minute";
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
};

// Checks every server on an interval, keeps the history, and alerts when something that should be up goes down.
export function createMonitor({ db, notifier, getStatus, now = () => Date.now(), sampler = createSampler() }) {
  const getState = db.prepare("SELECT * FROM server_state WHERE server_id = ?");
  const saveState = db.prepare(
    `INSERT INTO server_state (server_id, status, since, expected, fails, alerted) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET status = excluded.status, since = excluded.since,
       expected = excluded.expected, fails = excluded.fails, alerted = excluded.alerted`
  );
  const addCheck = db.prepare("INSERT INTO checks (server_id, ts, up) VALUES (?, ?, ?)");
  let ticks = 0;

  async function checkOne(server) {
    let status;
    try {
      status = await getStatus(server);
    } catch {
      status = "unknown";
    }
    const t = now();
    addCheck.run(server.id, t, status === "up" ? 1 : status === "down" ? 0 : null);

    const prev = getState.get(server.id) ?? { status: null, since: t, expected: null, fails: 0, alerted: 0 };
    let { expected, fails, alerted } = prev;
    let since = prev.status === status ? prev.since : t;
    const messages = [];

    if (status === "up") {
      expected = "up"; // seen running: from now on it's supposed to stay that way
      if (alerted) messages.push(`✅ ${server.name} is back up (was down for ${ago(t - prev.since)}).`);
      fails = 0;
      alerted = 0;
    } else if (status === "down") {
      fails += 1;
      if (expected === "up" && fails >= CONFIRM_FAILS && !alerted) {
        messages.push(`🔴 ${server.name} is DOWN. Nobody stopped it from Console.`);
        alerted = 1;
      }
    } else {
      since = prev.since; // "unknown" (a failed check, not a verdict) doesn't change anything
    }

    saveState.run(server.id, status === "unknown" ? prev.status : status, since, expected, fails, alerted);
    for (const m of messages) await notifier.send(m);
    return status;
  }

  async function tick() {
    const servers = listServers(db);
    await Promise.all(servers.map((s) => checkOne(s).catch(() => {})));

    const t = now();
    const s = sampler();
    db.prepare(
      "INSERT OR REPLACE INTO host_metrics (ts, cpu, mem_used, mem_total, disk_used, disk_total, load1) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(t, s.cpu, s.memUsed, s.memTotal, s.diskUsed, s.diskTotal, s.load1);

    if (++ticks % 60 === 1) {
      db.prepare("DELETE FROM checks WHERE ts < ?").run(t - KEEP_MS);
      db.prepare("DELETE FROM host_metrics WHERE ts < ?").run(t - KEEP_MS);
    }
  }

  let timer = null;
  return {
    tick,
    checkOne,
    start(everyMs) {
      tick().catch(() => {});
      timer = setInterval(() => tick().catch(() => {}), everyMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
  };
}

export function uptimePercent(db, serverId, sinceMs) {
  const r = db.prepare("SELECT COUNT(up) AS n, SUM(up) AS ups FROM checks WHERE server_id = ? AND ts >= ?").get(serverId, sinceMs);
  return r.n ? Math.round((r.ups / r.n) * 1000) / 10 : null;
}

// Metric history for charts, averaged into at most `points` buckets.
export function hostHistory(db, sinceMs, points = 120) {
  const rows = db.prepare("SELECT * FROM host_metrics WHERE ts >= ? ORDER BY ts").all(sinceMs);
  if (rows.length <= points) return rows;
  const size = Math.ceil(rows.length / points);
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const avg = (k) => {
      const v = chunk.map((r) => r[k]).filter((x) => x !== null);
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
    };
    out.push({ ts: chunk[chunk.length - 1].ts, cpu: avg("cpu"), mem_used: avg("mem_used"), mem_total: chunk[0].mem_total, disk_used: avg("disk_used"), disk_total: chunk[0].disk_total, load1: avg("load1") });
  }
  return out;
}
