import { McError } from "../mc/props.js";
import { ActionError } from "../runtime.js";
import { serverFor } from "../access.js";

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
  app.post("/api/servers/:id/mc/action", { preHandler: asOperator }, wrap(async (req) => mc.act(req.srv, req.user.username, req.body?.action, req.body)));
}
