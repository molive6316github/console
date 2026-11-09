import { audit } from "../db.js";
import { AssistantError } from "../assistant.js";

// Any signed-in person can chat (the assistant only does what their role allows). Owners pick the agent.
export function assistantRoutes(app, { db, need, assistant, safeMode }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof AssistantError) return reply.code(e.status ?? 400).send({ error: e.message }); throw e; }
  };
  const human = async (req, reply) => req.viaAgent && reply.code(403).send({ error: "Only a person can do that" });

  app.get("/api/assistant", { preHandler: need("viewer") }, wrap(async (req) => assistant.status(req.user)));
  app.put("/api/assistant", { preHandler: [need("admin"), human] }, wrap(async (req, reply) => {
    if (safeMode) return reply.code(403).send({ error: "Safe mode is on: this is disabled" });
    assistant.configure(req.body ?? {});
    audit(db, { username: req.user.username, action: "assistant_config", ok: true, detail: JSON.stringify({ enabled: req.body?.enabled, agent: req.body?.agent }) });
    return assistant.status(req.user);
  }));
  app.post("/api/assistant/message", { preHandler: [need("viewer"), human] }, wrap(async (req, reply) => {
    if (safeMode) return reply.code(403).send({ error: "Safe mode is on: the assistant is disabled" });
    const r = await assistant.send(req.user, req.body?.text);
    audit(db, { username: req.user.username, action: "assistant_ask", ok: true, detail: String(req.body?.text ?? "").slice(0, 80) });
    return r;
  }));
  app.get("/api/assistant/turns/:id", { preHandler: [need("viewer"), human] }, wrap(async (req, reply) => assistant.turn(req.user, req.params.id) ?? reply.code(404).send({ error: "No such conversation turn" })));
  app.post("/api/assistant/approvals/:id", { preHandler: [need("viewer"), human] }, wrap(async (req) => {
    const r = assistant.decide(req.user, req.params.id, req.body?.approve === true);
    audit(db, { username: req.user.username, action: "assistant_approval", ok: true, detail: `${r.state} ${req.params.id}` });
    return r;
  }));
  app.get("/api/assistant/approvals/:id", { preHandler: need("viewer") }, wrap(async (req) => assistant.approvalState(req.user, req.params.id)));
  app.get("/api/assistant/routes", { preHandler: need("viewer") }, async () => ({ routes: assistant.visibleRoutes() }));
  app.delete("/api/assistant/history", { preHandler: [need("viewer"), human] }, async (req) => { assistant.clear(req.user); return { ok: true }; });
}
