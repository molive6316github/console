import os from "node:os";
import { audit, getSetting, setSetting, getServer, listServers } from "../db.js";
import { destroyUserSessions } from "../auth.js";
import { listUsers, createUser, updateUser, deleteUser, UserError } from "../users.js";
import { validWebhook, maskWebhook } from "../notify.js";
import { validTimezone, parseCron } from "../cron.js";
import { SCHEDULE_ACTIONS, defaultTimezone } from "../scheduler.js";
import { getDriver } from "../drivers/index.js";
import { filesRootOf } from "../runtime.js";
import { hostHistory } from "../monitor.js";
import { visibleServers } from "../access.js";

const HOUR = 3_600_000;

export function adminRoutes(app, { db, need, runtime, notifier, scheduler, safeMode, terminal }) {
  // ---- users -----------------------------------------------------------------
  app.get("/api/users", { preHandler: need("admin") }, async () => listUsers(db));

  app.post("/api/users", { preHandler: need("admin") }, async (req) => {
    const id = createUser(db, req.body);
    audit(db, { username: req.user.username, action: "user_add", ok: true, detail: `${req.body.username} (${req.body.role})` });
    return { id };
  });

  app.put("/api/users/:id", { preHandler: need("admin") }, async (req) => {
    const id = Number(req.params.id);
    updateUser(db, id, req.body, req.user.id);
    // Role, scope or password changed: end their sessions so it applies now (never your own).
    if (id !== req.user.id) destroyUserSessions(db, id);
    audit(db, { username: req.user.username, action: "user_edit", ok: true, detail: `#${id}${req.body?.password ? " (password reset)" : ""}` });
    return { ok: true };
  });

  app.delete("/api/users/:id", { preHandler: need("admin") }, async (req) => {
    deleteUser(db, Number(req.params.id), req.user.id);
    audit(db, { username: req.user.username, action: "user_remove", ok: true, detail: `#${req.params.id}` });
    return { ok: true };
  });

  // ---- settings + alerts -----------------------------------------------------
  const settingsView = () => {
    const hook = getSetting(db, "alert_webhook");
    return {
      alertWebhook: maskWebhook(hook),
      alertsConfigured: Boolean(hook),
      terminalEnabled: getSetting(db, "terminal_enabled", "0") === "1",
      linuxUsersEnabled: getSetting(db, "linux_users_enabled", "0") === "1",
      githubToken: getSetting(db, "github_token", "") ? "••••" + String(getSetting(db, "github_token")).slice(-4) : "",
      timezone: defaultTimezone(db),
      backupKeep: Math.min(Math.max(parseInt(getSetting(db, "backup_keep", "7"), 10) || 7, 1), 50),
    };
  };

  app.get("/api/settings", { preHandler: need("admin") }, async () => settingsView());

  app.put("/api/settings", { preHandler: need("admin") }, async (req, reply) => {
    const b = req.body ?? {};
    if (b.alertWebhook !== undefined) {
      if (typeof b.alertWebhook !== "string") return reply.code(400).send({ error: "Bad webhook" });
      const url = b.alertWebhook.trim();
      const bad = url && validWebhook(url);
      if (bad) return reply.code(400).send({ error: bad });
      setSetting(db, "alert_webhook", url);
    }
    for (const [key, setting] of [["terminalEnabled", "terminal_enabled"], ["linuxUsersEnabled", "linux_users_enabled"]]) {
      if (b[key] === undefined) continue;
      if (typeof b[key] !== "boolean") return reply.code(400).send({ error: `${key} must be true or false` });
      if (b[key] && safeMode) return reply.code(403).send({ error: "Safe mode is on, so this can't be turned on" });
      setSetting(db, setting, b[key] ? "1" : "0");
      audit(db, { username: req.user.username, action: `${setting}_${b[key] ? "on" : "off"}`, ok: true });
      if (key === "terminalEnabled" && !b[key]) terminal.closeAll("terminal was turned off");
    }
    if (b.githubToken !== undefined) {
      const t = typeof b.githubToken === "string" ? b.githubToken.trim() : null;
      if (t === null || t.length > 255 || /\s/.test(t)) return reply.code(400).send({ error: "That doesn't look like a GitHub token" });
      setSetting(db, "github_token", t);
    }
    if (b.timezone !== undefined) {
      if (typeof b.timezone !== "string" || !validTimezone(b.timezone)) return reply.code(400).send({ error: "Unknown time zone (use a name like America/New_York)" });
      setSetting(db, "timezone", b.timezone);
    }
    if (b.backupKeep !== undefined) {
      const n = Number(b.backupKeep);
      if (!Number.isInteger(n) || n < 1 || n > 50) return reply.code(400).send({ error: "Keep between 1 and 50 backups" });
      setSetting(db, "backup_keep", n);
    }
    audit(db, { username: req.user.username, action: "settings", ok: true, detail: Object.keys(b).join(", ") }); // names only, never values
    return settingsView();
  });

  app.post("/api/alerts/test", { preHandler: need("admin") }, async (req, reply) => {
    const r = await notifier.send("✅ Test alert from Console. If you can read this, alerts work.");
    if (!r.sent) return reply.code(400).send({ error: r.reason === "no webhook set" ? "Save a webhook URL first" : `Couldn't send: ${r.reason}` });
    return { ok: true };
  });

  // ---- schedules -------------------------------------------------------------
  const scheduleView = (r) => ({
    id: r.id,
    serverId: r.server_id,
    serverName: getServer(db, r.server_id)?.name ?? r.server_id,
    action: r.action,
    arg: r.arg,
    cron: r.cron,
    enabled: r.enabled === 1,
    lastStatus: r.last_status,
    lastDetail: r.last_detail,
    next: r.enabled === 1 ? scheduler.nextRun(r) : null,
    createdBy: r.created_by,
  });

  function checkSchedule(b) {
    const server = typeof b.serverId === "string" ? getServer(db, b.serverId) : null;
    if (!server) return "Pick a server";
    if (!SCHEDULE_ACTIONS.includes(b.action)) return "Pick an action";
    try {
      parseCron(b.cron);
    } catch (e) {
      return e.message;
    }
    const driver = getDriver(server.type);
    if (b.action === "command") {
      if (safeMode) return "Safe mode is on: commands can't be scheduled";
      if (!driver.send) return "This kind of server can't take commands";
      if (typeof b.arg !== "string" || !b.arg.trim() || b.arg.length > 1000 || /[\r\n\0]/.test(b.arg)) return "Type the command (one line)";
    } else if (b.action === "backup") {
      if (!filesRootOf(server)) return "This server has no local files folder to back up";
    } else if (driver.readOnly) {
      return "This server is read-only";
    }
    return null;
  }

  app.get("/api/schedules", { preHandler: need("admin") }, async () =>
    db.prepare("SELECT * FROM schedules ORDER BY id").all().map(scheduleView)
  );

  app.post("/api/schedules", { preHandler: need("admin") }, async (req, reply) => {
    const b = req.body ?? {};
    const bad = checkSchedule(b);
    if (bad) return reply.code(400).send({ error: bad });
    if (db.prepare("SELECT COUNT(*) AS n FROM schedules").get().n >= 200) return reply.code(400).send({ error: "That's a lot of schedules (limit 200)" });
    const r = db
      .prepare("INSERT INTO schedules (server_id, action, arg, cron, enabled, created_by) VALUES (?, ?, ?, ?, 1, ?)")
      .run(b.serverId, b.action, b.action === "command" ? b.arg.trim() : null, b.cron.trim(), req.user.username);
    audit(db, { username: req.user.username, serverId: b.serverId, action: "schedule_add", ok: true, detail: `${b.action} @ ${b.cron}` });
    return { id: Number(r.lastInsertRowid) };
  });

  app.put("/api/schedules/:id", { preHandler: need("admin") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such schedule" });
    const b = { serverId: row.server_id, action: row.action, arg: row.arg, cron: row.cron, ...(req.body ?? {}) };
    const bad = checkSchedule(b);
    if (bad) return reply.code(400).send({ error: bad });
    const enabled = req.body?.enabled === undefined ? row.enabled : req.body.enabled ? 1 : 0;
    db.prepare("UPDATE schedules SET server_id = ?, action = ?, arg = ?, cron = ?, enabled = ? WHERE id = ?").run(
      b.serverId, b.action, b.action === "command" ? b.arg.trim() : null, b.cron.trim(), enabled, row.id
    );
    audit(db, { username: req.user.username, serverId: b.serverId, action: "schedule_edit", ok: true, detail: `#${row.id}` });
    return { ok: true };
  });

  app.delete("/api/schedules/:id", { preHandler: need("admin") }, async (req, reply) => {
    const r = db.prepare("DELETE FROM schedules WHERE id = ?").run(Number(req.params.id));
    if (!r.changes) return reply.code(404).send({ error: "No such schedule" });
    audit(db, { username: req.user.username, action: "schedule_remove", ok: true, detail: `#${req.params.id}` });
    return { ok: true };
  });

  app.post("/api/schedules/:id/run", { preHandler: need("admin") }, async (req, reply) => {
    const row = db.prepare("SELECT * FROM schedules WHERE id = ?").get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: "No such schedule" });
    const status = await scheduler.runOne(row, getServer(db, row.server_id));
    const fresh = db.prepare("SELECT last_detail FROM schedules WHERE id = ?").get(row.id);
    if (status === "failed" || status === "skipped") return reply.code(409).send({ error: fresh.last_detail ?? status });
    return { ok: true };
  });

  // ---- host metrics ----------------------------------------------------------
  // Machine-wide numbers: shown to admins and to users who can see every server, not to scoped staff.
  app.get("/api/host", { preHandler: need("viewer") }, async (req, reply) => {
    if (req.user.role !== "admin" && !req.user.allServers) return reply.code(403).send({ error: "Not available for your account" });
    const hours = Math.min(Math.max(parseInt(req.query?.hours, 10) || 24, 1), 168);
    const history = hostHistory(db, Date.now() - hours * HOUR);
    return {
      hours,
      history,
      current: history.at(-1) ?? null,
      host: os.hostname(),
      cores: os.cpus().length,
      uptimeSec: Math.floor(os.uptime()),
      servers: visibleServers(db, req.user).length,
      total: listServers(db).length,
    };
  });

  // ---- audit -----------------------------------------------------------------
  app.get("/api/audit", { preHandler: need("admin") }, async (req) => {
    const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 100, 1), 500);
    const server = typeof req.query?.server === "string" ? req.query.server : null;
    const sql = `SELECT id, ts, username, server_id, action, ok, detail FROM audit_log ${server ? "WHERE server_id = ?" : ""} ORDER BY id DESC LIMIT ?`;
    return server ? db.prepare(sql).all(server, limit) : db.prepare(sql).all(limit);
  });

  void runtime;
}
