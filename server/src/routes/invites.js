import { createInvites } from "../invites.js";
import { UserError } from "../users.js";
import { PERMS, PRESETS } from "../perms.js";
import { audit } from "../db.js";
import { loginThrottled, recordLoginFailure, clearLoginFailures, createSession } from "../auth.js";
import { serverFor } from "../access.js";

export function inviteRoutes(app, { db, need, safeMode, cookie }) {
  const invites = createInvites(db);
  const wrap = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof UserError) return reply.code(e.status ?? 400).send({ error: e.message });
      throw e;
    }
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: inviting people is disabled" });

  app.get("/api/perms", { preHandler: need("viewer") }, async () => ({ perms: PERMS, presets: PRESETS }));

  // ---- owners: create, list and cancel invite links ----
  const scoped = (req, reply) => {
    const s = serverFor(db, req.user, req.query?.server ?? req.body?.serverId);
    if (!s) return reply.code(404).send({ error: "No such server" });
    return s;
  };
  app.get("/api/invites", { preHandler: need("admin") }, wrap(async (req, reply) => {
    const s = scoped(req, reply); if (reply.sent) return;
    return invites.list(s.id);
  }));
  app.post("/api/invites", { preHandler: [need("admin"), noSafe] }, wrap(async (req, reply) => {
    const s = scoped(req, reply); if (reply.sent) return;
    const r = invites.create({ serverId: s.id, preset: req.body?.preset, perms: req.body?.perms, note: req.body?.note, days: req.body?.days, actor: req.user.username });
    audit(db, { username: req.user.username, serverId: s.id, action: "invite_create", ok: true, detail: `${req.body?.preset ?? "custom"}${req.body?.note ? ` (${String(req.body.note).slice(0, 40)})` : ""}` });
    return { id: r.id, token: r.token, expiresAt: r.expiresAt }; // the only time the link is ever shown
  }));
  app.delete("/api/invites/:id", { preHandler: need("admin") }, wrap(async (req, reply) => {
    if (!invites.revoke(Number(req.params.id))) return reply.code(404).send({ error: "No such open invite" });
    audit(db, { username: req.user.username, action: "invite_revoke", ok: true, detail: `#${req.params.id}` });
    return { ok: true };
  }));

  // ---- the person being invited (no account yet) ----
  const gone = (reply) => reply.code(404).send({ error: "This invite link isn't valid or has expired" });
  app.get("/api/invite/:token", wrap(async (req, reply) => {
    if (loginThrottled(req.ip)) return reply.code(429).send({ error: "Too many attempts, try again later" });
    const p = invites.peek(req.params.token);
    if (!p) { recordLoginFailure(req.ip); return gone(reply); }
    return p;
  }));
  app.post("/api/invite/:token/accept", { preHandler: noSafe }, wrap(async (req, reply) => {
    if (loginThrottled(req.ip)) return reply.code(429).send({ error: "Too many attempts, try again later" });
    let r;
    try {
      r = invites.accept(req.params.token, { username: req.body?.username, password: req.body?.password });
    } catch (e) {
      if (e instanceof UserError && e.status === 404) recordLoginFailure(req.ip);
      throw e;
    }
    clearLoginFailures(req.ip);
    audit(db, { username: r.username, serverId: r.serverId, action: "invite_accept", ok: true });
    const { token, maxAgeSec } = createSession(db, r.userId);
    reply.setCookie(cookie.name, token, { httpOnly: true, sameSite: "strict", secure: cookie.secure, path: "/", maxAge: maxAgeSec });
    return { username: r.username };
  }));
}
