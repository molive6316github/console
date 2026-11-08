import { audit } from "../db.js";
import { SiteError } from "../sites.js";

// The Website page: make a site on its own hostname, edit it in the browser.
export function siteRoutes(app, { db, need, sites, safeMode }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof SiteError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });
  const pre = [need("admin")];
  const edit = [need("admin"), noSafe];

  app.get("/api/sites", { preHandler: pre }, wrap(async () => ({ sites: await sites.list(), templates: Object.entries(sites.TEMPLATES).map(([id, v]) => ({ id, ...v })) })));
  app.post("/api/sites", { preHandler: edit }, wrap(async (req) => {
    const r = await sites.create(req.body ?? {});
    audit(db, { username: req.user.username, action: "site_create", ok: true, detail: r.host });
    return r;
  }));
  app.delete("/api/sites/:host", { preHandler: edit }, wrap(async (req) => {
    const r = await sites.remove(req.params.host);
    audit(db, { username: req.user.username, action: "site_delete", ok: true, detail: req.params.host });
    return r;
  }));
  app.post("/api/sites/:host/route", { preHandler: edit }, wrap(async (req) => sites.route(req.params.host)));
  app.get("/api/sites/:host/config", { preHandler: pre }, wrap(async (req) => ({ config: await sites.getConfig(req.params.host) })));
  app.put("/api/sites/:host/config", { preHandler: edit }, wrap(async (req) => {
    const config = await sites.putConfig(req.params.host, req.body ?? {});
    audit(db, { username: req.user.username, action: "site_edit", ok: true, detail: req.params.host });
    return { config };
  }));
  app.get("/api/sites/:host/files/:name", { preHandler: pre }, wrap(async (req) => ({ text: await sites.readFile(req.params.host, req.params.name) })));
  app.put("/api/sites/:host/files/:name", { preHandler: edit }, wrap(async (req) => {
    await sites.writeFile(req.params.host, req.params.name, req.body?.text);
    audit(db, { username: req.user.username, action: "site_file", ok: true, detail: `${req.params.host}/${req.params.name}` });
    return { ok: true };
  }));
  app.delete("/api/sites/:host/files/:name", { preHandler: edit }, wrap(async (req) => { await sites.deleteFile(req.params.host, req.params.name); return { ok: true }; }));
}
