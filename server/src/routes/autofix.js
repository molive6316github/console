import { audit } from "../db.js";
import { AutoFixError } from "../autofix.js";

// Admin-only. Settings, history, a "fix it now" button, and undo.
export function autofixRoutes(app, { db, need, autofix, connWatcher, safeMode }) {
  const gate = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });
  const pre = [need("admin"), gate];
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof AutoFixError || e.status) return reply.code(e.status ?? 400).send({ error: e.message }); throw e; }
  };

  app.get("/api/autofix", { preHandler: need("admin") }, wrap(async () => autofix.status()));
  app.put("/api/autofix", { preHandler: pre }, wrap(async (req) => {
    autofix.configure(req.body ?? {});
    audit(db, { username: req.user.username, action: "autofix_config", ok: true, detail: JSON.stringify({ enabled: req.body?.enabled, agent: req.body?.agent }) });
    return autofix.status();
  }));
  app.post("/api/autofix/run", { preHandler: pre }, wrap(async (req) => {
    const { scope, target, note } = req.body ?? {};
    const sc = await autofix.scopes[scope === "console" ? "console" : scope]?.(...(scope === "console" || scope === "link" ? [note] : [target, note]));
    if (!sc) throw new AutoFixError("Unknown scope");
    audit(db, { username: req.user.username, action: "autofix_run", ok: true, detail: `${scope} ${target ?? ""}` });
    const r = await autofix.fix({ scope: sc, title: `${scope}${target ? ` ${target}` : ""}`, actor: "manual", incident: null });
    return r;
  }));
  // Join failures caused by the server itself, for the panel's popup.
  app.get("/api/connfail", { preHandler: need("admin") }, async (req) => ({ alerts: connWatcher.list(Number(req.query?.since) || 0), autofix: (await autofix.status()).enabled }));
  app.post("/api/connfail/dismiss", { preHandler: need("admin") }, async (req) => { connWatcher.dismiss(Number(req.body?.id)); return { ok: true }; });
  app.post("/api/autofix/:id/undo", { preHandler: pre }, wrap(async (req) => {
    await autofix.undo(req.params.id);
    audit(db, { username: req.user.username, action: "autofix_undo", ok: true, detail: req.params.id });
    return autofix.status();
  }));
}
