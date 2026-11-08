import { getSetting, setSetting, audit } from "./db.js";
import { partsIn } from "./cron.js";
import { defaultTimezone } from "./scheduler.js";

const DEFAULTS = { enabled: false, hour: 4 };

// Nightly self-update. At the chosen hour (server timezone) it checks for a newer published release and applies it,
// but never while players are online (it keeps retrying until the hour is over). One attempt per day, so a broken
// release can't loop. The updater already rolls back if the build fails.
export function createAutoUpdate({ db, updater, notifier, playersOnline = async () => false, restart = () => {}, now = () => Date.now() }) {
  const get = () => {
    try { return { ...DEFAULTS, ...JSON.parse(getSetting(db, "auto_update", "{}")) }; } catch { return { ...DEFAULTS }; }
  };
  const set = (body) => {
    const cur = get();
    const next = { ...cur };
    if (body.enabled !== undefined) next.enabled = body.enabled === true;
    if (body.hour !== undefined) {
      const h = Number(body.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) throw new Error("Hour must be 0 to 23");
      next.hour = h;
    }
    setSetting(db, "auto_update", JSON.stringify(next));
    return next;
  };
  const lastRun = () => getSetting(db, "auto_update_last", "");

  async function tick() {
    const cfg = get();
    if (!cfg.enabled) return { skipped: "off" };
    const tz = defaultTimezone(db);
    const p = partsIn(new Date(now()), tz);
    if (p.hour !== cfg.hour) return { skipped: "not the hour" };
    const day = `${p.month}-${p.dom}`;
    if (lastRun() === day) return { skipped: "already tried today" };

    const info = await updater.check({ force: true }).catch((e) => ({ ok: false, error: e.message }));
    if (!info.supported || !info.ok) {
      setSetting(db, "auto_update_last", day);
      await notifier.send(`⚠️ Auto-update couldn't check for updates: ${info.error ?? "unknown error"}`).catch(() => {});
      return { error: info.error };
    }
    if (info.behind === 0) {
      setSetting(db, "auto_update_last", day);
      return { upToDate: true };
    }
    if (await playersOnline().catch(() => false)) return { postponed: true }; // try again on the next tick
    setSetting(db, "auto_update_last", day);
    const r = await updater.apply();
    audit(db, { username: "auto-update", action: "update", ok: r.ok, detail: r.ok ? (r.updated ? `${r.from} -> ${r.to}` : "already up to date") : r.error });
    if (!r.ok) {
      await notifier.send(`⚠️ Auto-update failed${r.rolledBack ? " and was rolled back" : ""}: ${r.error}`).catch(() => {});
      return { error: r.error };
    }
    if (r.updated) {
      await notifier.send(`⬆️ Console updated ${r.from} → ${r.to}${info.latestVersion ? ` (v${info.latestVersion})` : ""}. Restarting.`).catch(() => {});
      restart();
    }
    return { updated: r.updated };
  }

  return { tick, get, set, lastRun };
}
