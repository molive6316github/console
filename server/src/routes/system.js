import { audit } from "../db.js";

export function systemRoutes(app, { db, need, system, logs, jobs, safeMode, onlinePlayers, delayMs = 3000 }) {
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });

  app.get("/api/system", { preHandler: need("admin") }, async (req) => system.check({ force: req.query?.force === "1" }));
  app.get("/api/system/logs", { preHandler: need("admin") }, async () => ({ lines: logs.tail(400) }));

  app.post("/api/system/upgrade", { preHandler: [need("admin"), noSafe] }, async (req) => {
    const job = system.upgrade(req.user.username);
    audit(db, { username: req.user.username, action: "os_upgrade", ok: true });
    return { jobId: job.id };
  });

  // Restarting the whole machine kicks everyone out of the game, so it must be typed and refuses while players are on (unless forced).
  app.post("/api/system/reboot", { preHandler: [need("admin"), noSafe] }, async (req, reply) => {
    if (req.body?.confirm !== "restart") return reply.code(400).send({ error: 'Type "restart" to confirm' });
    if (!req.body?.force && (await onlinePlayers())) return reply.code(409).send({ error: "Players are online right now. Wait, or tick the box to restart anyway." });
    try {
      audit(db, { username: req.user.username, action: "machine_restart", ok: true });
      setTimeout(() => system.restartMachine().catch(() => {}), delayMs);
      return { ok: true };
    } catch (e) {
      return reply.code(e.status ?? 500).send({ error: e.message });
    }
  });
}
