import { getSetting, setSetting, audit, listServers } from "../db.js";
import { serverFor } from "../access.js";
import { mcRoot } from "../mc/index.js";
import { McError } from "../mc/props.js";

const TTL = 10_000;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function statusRoutes(app, { db, need, allow, mc, startup, safeMode }) {
  const cfg = () => {
    try { return { enabled: false, names: false, ...JSON.parse(getSetting(db, "public_status", "{}")) }; } catch { return { enabled: false, names: false }; }
  };
  const scoped = async (req, reply) => {
    const s = serverFor(db, req.user, req.params.id);
    if (!s || !mcRoot(s)) return reply.code(404).send({ error: "No such Minecraft server" });
    req.srv = s;
  };
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof McError) return reply.code(e.status ?? 400).send({ error: e.message }); throw e; }
  };

  // Live status for signed-in people who can see the console.
  app.get("/api/servers/:id/mc/status", { preHandler: [allow("console"), scoped] }, wrap(async (req) => mc.liveStatus(req.srv)));

  // Memory, Java flags, crash auto-restart and daily restart. Applies on the next start.
  app.get("/api/servers/:id/mc/startup", { preHandler: [allow("startup"), scoped] }, wrap(async (req) => startup.view(req.srv)));
  app.put("/api/servers/:id/mc/startup", { preHandler: [allow("startup"), scoped] }, wrap(async (req) => {
    if (safeMode) throw new McError("Safe mode is on, so changes are blocked", 403);
    const out = startup.update(req.srv, req.body ?? {});
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc-startup", ok: true, detail: `${out.memoryMb} MB, ${out.preset}` });
    return out;
  }));

  // The public page: no sign-in, opt-in, and only these few facts.
  let cache = { at: 0, body: null };
  app.get("/api/public/status", async (_req, reply) => {
    const c = cfg();
    if (!c.enabled) return { enabled: false };
    if (Date.now() - cache.at < TTL && cache.body) return cache.body;
    const server = listServers(db).find((s) => mcRoot(s) && (!c.server || s.id === c.server));
    if (!server) return { enabled: false };
    let st;
    try { st = await mc.liveStatus(server); } catch { st = { online: false }; }
    const body = {
      enabled: true,
      name: server.name,
      online: Boolean(st.online),
      players: st.online ? { online: st.players.online, max: st.players.max, ...(c.names ? { names: st.players.names } : {}) } : null,
      version: st.online ? st.version : null,
      motd: st.online ? st.motd : null,
      address: st.address ?? "",
    };
    cache = { at: Date.now(), body };
    return body;
  });

  // Owner settings for the public page and the join address.
  app.get("/api/servers/:id/mc/public", { preHandler: [need("admin"), scoped] }, wrap(async (req) => {
    const c = cfg();
    const j = mc.joinInfo(25565);
    return { enabled: c.enabled && (!c.server || c.server === req.srv.id), names: Boolean(c.names), domain: j.domain, srv: j.srv };
  }));
  app.put("/api/servers/:id/mc/public", { preHandler: [need("admin"), scoped] }, wrap(async (req, reply) => {
    const b = req.body ?? {};
    if (b.enabled !== undefined || b.names !== undefined) {
      const c = cfg();
      const next = { enabled: b.enabled === undefined ? c.enabled : b.enabled === true, names: b.names === undefined ? c.names : b.names === true, server: req.srv.id };
      setSetting(db, "public_status", JSON.stringify(next));
      cache = { at: 0, body: null };
    }
    if (b.domain !== undefined) {
      const d = String(b.domain).trim().toLowerCase();
      if (d && !DOMAIN.test(d)) return reply.code(400).send({ error: "That doesn't look like a valid domain name" });
      setSetting(db, "join_domain", d);
    }
    if (b.srv !== undefined) setSetting(db, "join_srv", b.srv === true ? "1" : "0");
    cache = { at: 0, body: null };
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc_public_settings", ok: true, detail: Object.keys(b).join(", ") });
    return { ok: true };
  }));
  void safeMode;
}
