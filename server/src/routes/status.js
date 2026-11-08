import { getSetting, setSetting, audit, listServers } from "../db.js";
import { serverFor } from "../access.js";
import { mcRoot } from "../mc/index.js";
import { McError } from "../mc/props.js";
import { parseTps } from "../mc/stats.js";

const TTL = 10_000;
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function statusRoutes(app, { db, need, allow, mc, startup, stats, setups, jobs, safeMode }) {
  const jobServer = new Map(); // job id -> server id, so people with 'versions' only see this server's jobs
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

  // CPU / RAM history (sampled in the background) and, when asked, a fresh TPS reading.
  app.get("/api/servers/:id/mc/stats", { preHandler: [allow("console"), scoped] }, wrap(async (req) => {
    const flavor = setups.metaOf(req.srv.id)?.flavor;
    if (req.query?.tps === "1" && flavor !== "fabric" && stats.tpsAge(req.srv.id) > 60_000 && req.user && (await mc.runtimeStatus(req.srv)) === "up") {
      const text = await mc.readTps(req.srv, flavor).catch(() => null);
      const t = text && parseTps(text);
      if (t) stats.setTps(req.srv.id, t);
    }
    return stats.view(req.srv.id);
  }));

  // Memory, Java flags, crash auto-restart and daily restart. Applies on the next start.
  app.get("/api/servers/:id/mc/startup", { preHandler: [allow("startup"), scoped] }, wrap(async (req) => startup.view(req.srv)));
  app.put("/api/servers/:id/mc/startup", { preHandler: [allow("startup"), scoped] }, wrap(async (req) => {
    if (safeMode) throw new McError("Safe mode is on, so changes are blocked", 403);
    const out = startup.update(req.srv, req.body ?? {});
    audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc-startup", ok: true, detail: `${out.memoryMb} MB, ${out.preset}` });
    return out;
  }));

  // What DNS records the join address needs, in plain terms.
  app.get("/api/servers/:id/mc/join", { preHandler: [allow("console"), scoped] }, wrap(async (req) => {
    const live = await mc.liveStatus(req.srv);
    const { host, port, domain, srv } = live;
    const ip = host && !domain ? host : (live.ip ?? "");
    const records = [];
    if (domain && ip) {
      records.push({ type: "A", name: domain, value: ip, note: "Points your domain at this machine." });
      if (port !== 25565) records.push({ type: "SRV", name: `_minecraft._tcp.${domain}`, value: `0 5 ${port} ${domain}`, note: "Lets players join without typing the port. Priority 0, weight 5." });
    }
    return { address: live.address, domain, ip, port, srv, records, needsSrv: Boolean(domain) && port !== 25565 };
  }));

  // Version switcher.
  app.get("/api/servers/:id/mc/version", { preHandler: [allow("versions"), scoped] }, wrap(async (req, reply) => {
    const meta = setups.metaOf(req.srv.id) ?? {};
    const flavor = String(req.query?.flavor ?? meta.flavor ?? "paper");
    if (!setups.flavors[flavor]) return reply.code(400).send({ error: "Unknown server type" });
    let list = [];
    try { list = await setups.versions(flavor); } catch (e) { return reply.code(502).send({ error: e.message }); }
    return {
      current: meta.kind === "minecraft" ? { flavor: meta.flavor, version: meta.version } : null,
      flavors: Object.entries(setups.flavors).map(([id, f]) => ({ id, label: f.label, blurb: f.blurb })),
      flavor, versions: list,
    };
  }));
  app.post("/api/servers/:id/mc/version", { preHandler: [allow("versions"), scoped] }, wrap(async (req) => {
    if (safeMode) throw new McError("Safe mode is on, so changes are blocked", 403);
    try {
      const job = await mc.switchVersion(req.srv, req.body, req.user.username);
      jobServer.set(job.id, req.srv.id);
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc-version", ok: true, detail: `${req.body?.flavor} ${req.body?.version}` });
      return { jobId: job.id };
    } catch (e) {
      audit(db, { username: req.user.username, serverId: req.srv.id, action: "mc-version", ok: false, detail: e.message });
      throw e;
    }
  }));
  app.get("/api/servers/:id/mc/job/:jobId", { preHandler: [allow("versions"), scoped] }, async (req, reply) => {
    if (jobServer.get(req.params.jobId) !== req.srv.id) return reply.code(404).send({ error: "No such job" });
    const j = jobs.get(req.params.jobId, Math.max(0, parseInt(req.query?.since ?? "0", 10) || 0));
    return j ?? reply.code(404).send({ error: "No such job" });
  });

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
