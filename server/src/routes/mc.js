import { McError } from "../mc/props.js";
import { ActionError } from "../runtime.js";
import { serverFor } from "../access.js";
import { audit } from "../db.js";

export function mcRoutes(app, { db, need, mc, safeMode }) {
  const scoped = async (req, reply) => {
    const s = serverFor(db, req.user, req.params.id);
    if (!s) return reply.code(404).send({ error: "No such server" });
    req.srv = s;
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });
  const wrap = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof McError || e instanceof ActionError) return reply.code(e.status ?? 400).send({ error: e.message });
      throw e;
    }
  };
  const asOperator = [need("operator"), scoped, noSafe];
  const asAdmin = [need("admin"), scoped];

  app.get("/api/servers/:id/mc/properties", { preHandler: asAdmin }, wrap(async (req) => mc.getProps(req.srv)));
  app.put("/api/servers/:id/mc/properties", { preHandler: [...asAdmin, noSafe] }, wrap(async (req) => mc.setProps(req.srv, req.body?.changes)));
  app.get("/api/servers/:id/mc/players", { preHandler: [need("operator"), scoped] }, wrap(async (req) => mc.players(req.srv)));
  // ---- plugins / mods (admin; installing one runs someone else's code on your server) ----
  const edit = [...asAdmin, noSafe];
  const auditIt = (req, action, detail) => audit(db, { username: req.user.username, serverId: req.srv?.id, action, ok: true, detail });
  app.get("/api/servers/:id/mc/plugins", { preHandler: asAdmin }, wrap(async (req) => mc.plugins.list(req.srv)));
  app.post("/api/servers/:id/mc/plugins/toggle", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.toggle(req.srv, req.body?.file, req.body?.enabled);
    auditIt(req, "plugin_toggle", `${req.body?.file} -> ${req.body?.enabled === true ? "on" : "off"}`);
    return r;
  }));
  app.post("/api/servers/:id/mc/plugins/delete", { preHandler: edit }, wrap(async (req) => {
    await mc.plugins.remove(req.srv, req.body?.file);
    auditIt(req, "plugin_delete", String(req.body?.file));
    return { ok: true };
  }));
  app.get("/api/servers/:id/mc/modrinth/search", { preHandler: asAdmin }, wrap(async (req) => mc.plugins.modrinthSearch(req.srv, req.query?.q, req.query?.version)));
  app.post("/api/servers/:id/mc/modrinth/install", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.modrinthInstall(req.srv, req.body?.slug, req.body?.version);
    auditIt(req, "plugin_install", `modrinth:${req.body?.slug} ${r.file}`);
    return r;
  }));
  app.get("/api/github/repos", { preHandler: need("admin") }, wrap(async (req) => mc.plugins.githubRepos(req.query?.owner)));
  app.get("/api/github/releases", { preHandler: need("admin") }, wrap(async (req) => mc.plugins.githubReleases(req.query?.repo)));
  app.post("/api/servers/:id/mc/github/install", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.githubInstall(req.srv, req.body?.repo, req.body?.assetId);
    auditIt(req, "plugin_install", `github:${req.body?.repo} ${r.file}`);
    return r;
  }));

  // ---- world backups / restore / reset (admin) ----
  app.post("/api/servers/:id/mc/backup", { preHandler: edit }, wrap(async (req) => mc.safeBackup(req.srv, req.user.username)));
  app.post("/api/servers/:id/mc/restore", { preHandler: edit }, wrap(async (req) => {
    try {
      const r = await mc.restore(req.srv, req.body?.name, req.body?.confirm);
      auditIt(req, "mc_restore", `${req.body?.name}; previous files kept at ${r.previousKeptAt}`);
      return r;
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc_restore", ok: false, detail: e.message });
      throw e;
    }
  }));
  app.post("/api/servers/:id/mc/reset-world", { preHandler: edit }, wrap(async (req) => {
    try {
      const r = await mc.reset(req.srv, req.body?.confirm);
      auditIt(req, "mc_reset_world", `moved to ${r.movedTo}`);
      return r;
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc_reset_world", ok: false, detail: e.message });
      throw e;
    }
  }));

  // ---- GitHub sync (admin) ----
  app.get("/api/servers/:id/mc/github", { preHandler: asAdmin }, wrap(async (req) => mc.gh.get(req.srv)));
  app.put("/api/servers/:id/mc/github", { preHandler: edit }, wrap(async (req) => {
    const r = mc.gh.set(req.srv, req.body ?? {});
    auditIt(req, "mc_github_settings", `${r.repo || "(none)"} keep ${r.keep}`);
    return r;
  }));
  app.post("/api/servers/:id/mc/github/push-config", { preHandler: edit }, wrap(async (req) => {
    const job = mc.gh.pushConfig(req.srv, req.user.username);
    auditIt(req, "mc_github_config", "started");
    return { jobId: job.id };
  }));
  app.post("/api/servers/:id/mc/github/push-world", { preHandler: edit }, wrap(async (req) => {
    const job = mc.gh.pushWorld(req.srv, req.user.username);
    auditIt(req, "mc_github_world", "started");
    return { jobId: job.id };
  }));

  app.post("/api/servers/:id/mc/action", { preHandler: asOperator }, wrap(async (req) => mc.act(req.srv, req.user.username, req.body?.action, req.body)));
}
