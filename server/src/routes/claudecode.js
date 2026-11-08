import { audit } from "../db.js";

// Admin-only, off until switched on, and everything needs the web terminal too (that's where you sign in).
export function claudeCodeRoutes(app, { db, need, claude, terminal, safeMode }) {
  const gate = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });
  const pre = [need("admin"), gate];

  app.get("/api/claude-code", { preHandler: need("admin") }, async () => ({ ...(await claude.status()), terminalEnabled: terminal.enabled(), safeMode: Boolean(safeMode) }));
  app.put("/api/claude-code", { preHandler: pre }, async (req, reply) => {
    const on = req.body?.enabled === true;
    if (on && !terminal.enabled()) return reply.code(400).send({ error: "Turn on the web terminal first (Advanced tools above). That's where you sign in." });
    claude.set(on);
    audit(db, { username: req.user.username, action: "claude_code", ok: true, detail: on ? "enabled" : "disabled" });
    return claude.status();
  });
  app.post("/api/claude-code/install", { preHandler: pre }, async (req, reply) => {
    if (!claude.enabled()) return reply.code(400).send({ error: "Turn Claude Code on first" });
    audit(db, { username: req.user.username, action: "claude_code_install", ok: true });
    return { jobId: claude.install(req.user.username).id };
  });
  app.delete("/api/claude-code", { preHandler: pre }, async (req) => {
    await claude.uninstall();
    audit(db, { username: req.user.username, action: "claude_code_remove", ok: true });
    return claude.status();
  });
}
