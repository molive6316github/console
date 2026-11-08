import { audit } from "../db.js";

// Admin only. Reading is always allowed; anything that deletes or kills is off in safe mode.
export function discoverRoutes(app, { db, need, discover, safeMode }) {
  const admin = need("admin");
  const destructive = [
    admin,
    async (req, reply) => {
      if (safeMode) return reply.code(403).send({ error: "Safe mode is on (CONSOLE_SAFE_MODE=1): deleting is disabled" });
    },
  ];

  for (const name of ["tmux", "docker", "systemd", "processes", "folders", "cleanup"]) {
    app.get(`/api/discover/${name}`, { preHandler: admin }, async () => discover[name]());
  }

  const log = (req, action, ok, detail) => audit(db, { username: req.user.username, action, ok, detail });
  const wrap = (action, fn, describe) => async (req) => {
    try {
      const r = await fn(req.body ?? {});
      log(req, action, true, describe(req.body ?? {}, r));
      return r;
    } catch (e) {
      log(req, action, false, `${describe(req.body ?? {}, null)}: ${e.message}`);
      throw e;
    }
  };

  app.post("/api/discover/tmux/kill", { preHandler: destructive }, wrap("kill_tmux", (b) => discover.killTmux(b.session), (b) => String(b.session).slice(0, 80)));
  app.post("/api/discover/docker/remove", { preHandler: destructive }, wrap("docker_remove", (b) => discover.dockerRemove(b), (b) => `${b.kind} ${String(b.id).slice(0, 100)}${b.force ? " (force)" : ""}`));
  app.post("/api/discover/docker/prune", { preHandler: destructive }, wrap("docker_prune", (b) => discover.dockerPrune(b.what), (b, r) => `${b.what}${r ? ` reclaimed ${r.reclaimed}` : ""}`));
  app.post("/api/discover/folder/delete", { preHandler: destructive }, wrap("delete_folder", (b) => discover.deleteFolder(b), (b, r) => `${String(b.path).slice(0, 200)}${r ? ` (${r.freedKB ?? "?"} KB${r.archived ? `, saved copy ${r.archived}` : ", no copy"})` : ""}`));
  app.post("/api/discover/cleanup/delete", { preHandler: destructive }, wrap("cleanup_delete", (b) => discover.cleanupDelete(b), (b) => `${b.kind} ${String(b.name).slice(0, 100)}`));
}
