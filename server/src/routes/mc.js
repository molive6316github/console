import { McError } from "../mc/props.js";
import { ActionError } from "../runtime.js";
import { serverFor } from "../access.js";
import { audit } from "../db.js";

export function mcRoutes(app, { db, need, allow, mc, safeMode }) {
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
  const asPlayers = [allow("players"), scoped, noSafe];
  const asAdmin = [need("admin"), scoped]; // GitHub sync uses the owner's token: owners only
  const asSettings = [allow("settings"), scoped];
  const asPlugins = [allow("plugins"), scoped];
  const asBackups = [allow("backups"), scoped];

  app.get("/api/servers/:id/mc/properties", { preHandler: asSettings }, wrap(async (req) => mc.getProps(req.srv)));
  app.put("/api/servers/:id/mc/properties", { preHandler: [...asSettings, noSafe] }, wrap(async (req) => mc.setProps(req.srv, req.body?.changes)));
  app.get("/api/servers/:id/mc/players", { preHandler: [allow("players"), scoped] }, wrap(async (req) => mc.players(req.srv)));
  // ---- plugins / mods (admin; installing one runs someone else's code on your server) ----
  const edit = [...asPlugins, noSafe];
  const editBackups = [...asBackups, noSafe];
  const editOwner = [...asAdmin, noSafe];
  const auditIt = (req, action, detail) => audit(db, { username: req.user.username, serverId: req.srv?.id, action, ok: true, detail });
  app.get("/api/servers/:id/mc/plugins", { preHandler: asPlugins }, wrap(async (req) => mc.plugins.list(req.srv)));
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
  app.get("/api/servers/:id/mc/modrinth/search", { preHandler: asPlugins }, wrap(async (req) => mc.plugins.modrinthSearch(req.srv, req.query?.q, req.query?.version)));
  app.post("/api/servers/:id/mc/modrinth/install", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.modrinthInstall(req.srv, req.body?.slug, req.body?.version);
    auditIt(req, "plugin_install", `modrinth:${req.body?.slug} ${r.file}`);
    return r;
  }));
  app.get("/api/servers/:id/mc/catalog", { preHandler: asPlugins }, wrap(async (req) => mc.plugins.catalog(req.srv, req.query?.version)));
  app.post("/api/servers/:id/mc/catalog/install", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.installMany(req.srv, req.body?.slugs, req.body?.version);
    auditIt(req, "plugin_install", `catalog: ${r.results.filter((x) => x.ok && !x.skipped).map((x) => x.slug).join(", ") || "nothing new"}`);
    return r;
  }));
  app.get("/api/github/repos", { preHandler: allow("plugins") }, wrap(async (req) => mc.plugins.githubRepos(req.query?.owner)));
  app.get("/api/github/releases", { preHandler: allow("plugins") }, wrap(async (req) => mc.plugins.githubReleases(req.query?.repo)));
  app.post("/api/servers/:id/mc/github/install", { preHandler: edit }, wrap(async (req) => {
    const r = await mc.plugins.githubInstall(req.srv, req.body?.repo, req.body?.assetId);
    auditIt(req, "plugin_install", `github:${req.body?.repo} ${r.file}`);
    return r;
  }));

  // ---- world backups / restore / reset (admin) ----
  app.post("/api/servers/:id/mc/backup", { preHandler: editBackups }, wrap(async (req) => mc.safeBackup(req.srv, req.user.username)));
  app.post("/api/servers/:id/mc/restore", { preHandler: editBackups }, wrap(async (req) => {
    try {
      const r = await mc.restore(req.srv, req.body?.name, req.body?.confirm);
      auditIt(req, "mc_restore", `${req.body?.name}; previous files kept at ${r.previousKeptAt}`);
      return r;
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc_restore", ok: false, detail: e.message });
      throw e;
    }
  }));
  app.post("/api/servers/:id/mc/reset-world", { preHandler: editBackups }, wrap(async (req) => {
    try {
      const r = await mc.reset(req.srv, req.body?.confirm);
      auditIt(req, "mc_reset_world", `moved to ${r.movedTo}`);
      return r;
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc_reset_world", ok: false, detail: e.message });
      throw e;
    }
  }));


  // ---- worlds & maps ----
  const mapsAudit = (req, action, detail) => auditIt(req, action, detail);
  app.get("/api/servers/:id/mc/worlds", { preHandler: asBackups }, wrap(async (req) => mc.maps.list(req.srv)));
  // Raw zip body. The custom x-console-upload header can't be sent by another website without a CORS preflight, so this is safe from cross-site posts.
  app.post("/api/servers/:id/mc/worlds/upload", { preHandler: [...editBackups, async (req, reply) => {
    if (req.headers["x-console-upload"] !== "1") return reply.code(400).send({ error: "Bad upload request" });
  }] }, wrap(async (req) => {
    const r = await mc.maps.upload(req.srv, req.body, String(req.query?.name ?? ""));
    mapsAudit(req, "world_upload", r.name);
    return r;
  }));
  app.get("/api/servers/:id/mc/worlds/:world/download", { preHandler: editBackups }, wrap(async (req, reply) => {
    const { stream, filename } = await mc.maps.download(req.srv, req.params.world);
    mapsAudit(req, "world_download", req.params.world);
    reply.header("content-disposition", `attachment; filename="${filename}"`).type("application/zip");
    return reply.send(stream);
  }));
  app.post("/api/servers/:id/mc/worlds/import-url", { preHandler: editBackups }, wrap(async (req) => {
    const job = mc.maps.importUrl(req.srv, String(req.body?.url ?? ""), String(req.body?.name ?? ""), req.user.username);
    mapsAudit(req, "world_import_url", `${req.body?.name} from ${req.body?.url}`);
    return { jobId: job.id };
  }));
  app.post("/api/servers/:id/mc/worlds/archive", { preHandler: editBackups }, wrap(async (req) => {
    const r = await mc.maps.archive(req.srv, req.body?.name, req.body?.confirm);
    mapsAudit(req, "world_archive", `${req.body?.name} -> ${r.movedTo}`);
    return r;
  }));
  app.post("/api/servers/:id/mc/worlds/set-main", { preHandler: editBackups }, wrap(async (req) => {
    const r = await mc.maps.setMain(req.srv, req.body?.name, req.body?.confirm);
    mapsAudit(req, "world_set_main", `${r.previous} -> ${r.main}`);
    return r;
  }));
  app.post("/api/servers/:id/mc/worlds/activate", { preHandler: editBackups }, wrap(async (req) => {
    const r = await mc.maps.activate(req.srv, req.body?.name, req.body?.env);
    mapsAudit(req, "world_activate", r.sent);
    return r;
  }));
  app.get("/api/servers/:id/mc/lobby", { preHandler: asBackups }, wrap(async (req) => mc.maps.lobbyPlan(req.srv, String(req.query?.name ?? ""))));
  app.post("/api/servers/:id/mc/lobby/run", { preHandler: editBackups }, wrap(async (req) => {
    const r = await mc.maps.lobbyRun(req.srv, req.body?.commands);
    mapsAudit(req, "lobby_run", `${r.results.length} commands, ${r.results.filter((x) => !x.ok).length} problems`);
    return r;
  }));

  // ---- GitHub sync (admin) ----
  app.get("/api/servers/:id/mc/github", { preHandler: asAdmin }, wrap(async (req) => mc.gh.get(req.srv)));
  app.put("/api/servers/:id/mc/github", { preHandler: editOwner }, wrap(async (req) => {
    const r = mc.gh.set(req.srv, req.body ?? {});
    auditIt(req, "mc_github_settings", `${r.repo || "(none)"} keep ${r.keep}`);
    return r;
  }));
  app.post("/api/servers/:id/mc/github/push-config", { preHandler: editOwner }, wrap(async (req) => {
    const job = mc.gh.pushConfig(req.srv, req.user.username);
    auditIt(req, "mc_github_config", "started");
    return { jobId: job.id };
  }));
  app.post("/api/servers/:id/mc/github/push-world", { preHandler: editOwner }, wrap(async (req) => {
    const job = mc.gh.pushWorld(req.srv, req.user.username);
    auditIt(req, "mc_github_world", "started");
    return { jobId: job.id };
  }));

  app.post("/api/servers/:id/mc/action", { preHandler: asPlayers }, wrap(async (req) => mc.act(req.srv, req.user.username, req.body?.action, req.body)));
}
