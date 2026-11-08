import { createReadStream } from "node:fs";
import { getServer, listServers, deleteServer, audit } from "../db.js";
import { getDriver } from "../drivers/index.js";
import { visibleServers, serverFor } from "../access.js";
import { LIFECYCLE, capsOf, filesRootOf, ActionError } from "../runtime.js";
import { uptimePercent } from "../monitor.js";
import { validateServerInput, idTaken, InputError } from "../servers.js";
import { createFiles, FileError } from "../files.js";
import { BACKUP_NAME } from "../backups.js";

const DAY = 86_400_000;

export function serverRoutes(app, { db, need, runtime, safeMode }) {
  const scoped = async (req, reply) => {
    const s = serverFor(db, req.user, req.params.id);
    if (!s) return reply.code(404).send({ error: "No such server" });
    req.srv = s;
  };
  const view = [need("viewer"), scoped];
  const operate = [need("operator"), scoped];
  const admin = [need("admin"), scoped];
  const noSafeMode = async (req, reply) => {
    if (safeMode) return reply.code(403).send({ error: "Safe mode is on (CONSOLE_SAFE_MODE=1): this is disabled" });
  };

  async function shape(s, user) {
    let status = "unknown";
    let error = null;
    try {
      status = await runtime.status(s);
    } catch (e) {
      error = e.message;
    }
    const caps = capsOf(s);
    const isAdmin = user.role === "admin";
    const operator = user.role === "operator" || isAdmin;
    // The target (hosts, commands, paths) stays server-side: it is not sent to the browser, except to admins on the edit screen.
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      source: s.source,
      status,
      error,
      busy: runtime.busy.has(s.id),
      uptime24h: uptimePercent(db, s.id, Date.now() - DAY),
      caps,
      canAct: operator && !caps.readOnly,
      canSend: operator && caps.send && !safeMode,
      canEditFiles: isAdmin && caps.files && !safeMode,
      canBackup: isAdmin && caps.files,
      canEditConfig: isAdmin && s.source === "ui" && !safeMode,
    };
  }

  app.get("/api/servers", { preHandler: need("viewer") }, async (req) =>
    Promise.all(visibleServers(db, req.user).map((s) => shape(s, req.user)))
  );

  app.get("/api/servers/:id", { preHandler: view }, async (req) => shape(req.srv, req.user));

  // ---- add / edit / remove (admin) --------------------------------------------
  app.get("/api/servers/:id/config", { preHandler: admin }, async (req) => {
    const { id, name, type, source, target } = req.srv;
    return { id, name, type, source, target };
  });

  app.post("/api/servers", { preHandler: [need("admin"), noSafeMode] }, async (req, reply) => {
    let row;
    try {
      row = validateServerInput(req.body);
    } catch (e) {
      if (e instanceof InputError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    if (idTaken(db, row.id)) return reply.code(409).send({ error: "A server with that ID already exists" });
    db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES (?, ?, ?, ?, 'ui')").run(row.id, row.name, row.type, JSON.stringify(row.target));
    audit(db, { username: req.user.username, serverId: row.id, action: "server_add", ok: true, detail: `${row.type}` });
    return { id: row.id };
  });

  const editable = async (req, reply) => {
    if (req.srv.source !== "ui") {
      return reply.code(409).send({ error: "This server is defined in servers.json. Change it there." });
    }
  };

  app.put("/api/servers/:id", { preHandler: [...admin, noSafeMode, editable] }, async (req, reply) => {
    let row;
    try {
      row = validateServerInput(req.body, { requireId: false });
    } catch (e) {
      if (e instanceof InputError) return reply.code(400).send({ error: e.message });
      throw e;
    }
    if (runtime.busy.has(req.srv.id)) return reply.code(409).send({ error: "An action is running on this server right now" });
    db.prepare("UPDATE servers SET name = ?, type = ?, target = ? WHERE id = ?").run(row.name, row.type, JSON.stringify(row.target), req.srv.id);
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "server_edit", ok: true });
    return { ok: true };
  });

  app.delete("/api/servers/:id", { preHandler: [...admin, noSafeMode, editable] }, async (req, reply) => {
    if (runtime.busy.has(req.srv.id)) return reply.code(409).send({ error: "An action is running on this server right now" });
    deleteServer(db, req.srv.id);
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "server_remove", ok: true, detail: "removed from Console only; the real server was not touched" });
    return { ok: true };
  });

  // ---- actions -------------------------------------------------------------
  app.post("/api/servers/:id/command", { preHandler: [...operate, noSafeMode] }, async (req, reply) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "Type a command" });
    await runtime.perform(req.srv, "command", req.user.username, text.trim());
    return { ok: true };
  });

  app.post("/api/servers/:id/:action", { preHandler: operate }, async (req, reply) => {
    const { action } = req.params;
    if (!LIFECYCLE.includes(action)) return reply.code(400).send({ error: "Unknown action" });
    return runtime.perform(req.srv, action, req.user.username);
  });

  // ---- logs ----------------------------------------------------------------
  app.get("/api/servers/:id/logs", { preHandler: view }, async (req, reply) => {
    if (!capsOf(req.srv).logs) return reply.code(400).send({ error: "This kind of server has no logs" });
    const lines = Math.min(Math.max(parseInt(req.query?.lines, 10) || 300, 10), 2000);
    try {
      const text = await getDriver(req.srv.type).logs(req.srv.target, lines, { id: req.srv.id });
      return { text: String(text ?? "") };
    } catch (e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  // ---- files (admin) -------------------------------------------------------
  const fileTools = async (req, reply) => {
    const root = filesRootOf(req.srv);
    if (!root) return reply.code(404).send({ error: "This server has no files folder set" });
    try {
      req.fileTools = createFiles(root);
    } catch (e) {
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  };
  const fileAdmin = [...admin, noSafeMode, fileTools];

  app.get("/api/servers/:id/files", { preHandler: fileAdmin }, async (req) => req.fileTools.list(req.query?.path));
  app.get("/api/servers/:id/file", { preHandler: fileAdmin }, async (req) => req.fileTools.read(req.query?.path));
  app.put("/api/servers/:id/file", { preHandler: fileAdmin }, async (req, reply) => {
    const { path: p, content, mtime } = req.body ?? {};
    try {
      const r = await req.fileTools.write(p, content, mtime);
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "file_edit", ok: true, detail: `${r.path} (${r.size} bytes)` });
      return r;
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "file_edit", ok: false, detail: `${String(p).slice(0, 200)}: ${e.message}` });
      throw e;
    }
  });

  // ---- backups (admin) -----------------------------------------------------
  const backupAdmin = [
    ...admin,
    async (req, reply) => {
      if (!filesRootOf(req.srv)) return reply.code(404).send({ error: "This server has no files folder set" });
    },
  ];
  app.get("/api/servers/:id/backups", { preHandler: backupAdmin }, async (req) => runtime.backups.list(req.srv.id));
  app.post("/api/servers/:id/backups", { preHandler: backupAdmin }, async (req) => runtime.perform(req.srv, "backup", req.user.username));
  app.get("/api/servers/:id/backups/:name", { preHandler: backupAdmin }, async (req, reply) => {
    const p = BACKUP_NAME.test(req.params.name) ? runtime.backups.pathFor(req.srv.id, req.params.name) : null;
    if (!p) return reply.code(404).send({ error: "No such backup" });
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "backup_download", ok: true, detail: req.params.name });
    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${req.srv.id}-${req.params.name}"`);
    return reply.send(createReadStream(p));
  });
  app.delete("/api/servers/:id/backups/:name", { preHandler: backupAdmin }, async (req, reply) => {
    if (!(await runtime.backups.remove(req.srv.id, req.params.name))) return reply.code(404).send({ error: "No such backup" });
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "backup_delete", ok: true, detail: req.params.name });
    return { ok: true };
  });

  void getServer; void listServers; void ActionError; void FileError;
}
