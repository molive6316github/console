import { getSetting, setSetting } from "./db.js";
import { validWebhook } from "./notify.js";
import { validTimezone } from "./cron.js";

// First-run settings handed over by the installer wizard through the environment.
// Only fills in what is still empty, so it can never overwrite something you changed in the dashboard.
const SEEDS = [
  ["CONSOLE_GITHUB_TOKEN", "github_token", (v) => v.length <= 255 && !/\s/.test(v)],
  ["CONSOLE_GITHUB_ORG", "github_org", (v) => /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(v)],
  ["CONSOLE_TIMEZONE", "timezone", (v) => validTimezone(v)],
  ["CONSOLE_ALERT_WEBHOOK", "alert_webhook", (v) => !validWebhook(v)],
  ["CONSOLE_BACKUP_KEEP", "backup_keep", (v) => /^\d+$/.test(v) && +v >= 1 && +v <= 50],
  ["CONSOLE_ENABLE_TERMINAL", "terminal_enabled", (v) => v === "1", () => "1"],
  ["CONSOLE_ENABLE_LINUX_USERS", "linux_users_enabled", (v) => v === "1", () => "1"],
];

export function seedSettings(db, env = process.env) {
  const applied = [];
  for (const [name, key, ok, map = (v) => v] of SEEDS) {
    const v = (env[name] ?? "").trim();
    if (!v) continue;
    if (getSetting(db, key, "") !== "") continue;
    if (!ok(v)) continue;
    setSetting(db, key, map(v));
    applied.push(key); // names only, never values
  }
  return applied;
}
