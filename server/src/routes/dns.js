import { getSetting, setSetting, audit, listServers } from "../db.js";
import { mcRoot } from "../mc/index.js";
import { wantedRecords, createChecker, createProvider, guessProvider, DnsError, validHost } from "../dns.js";

// Records you need, whether they're live yet, and (optionally) adding them for you through your DNS provider's API.
export function dnsRoutes(app, { db, need, mc, safeMode, publicIp, fetchImpl = fetch, check = createChecker(), guess = guessProvider, providerFor = createProvider }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof DnsError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });
  const saved = () => { try { return JSON.parse(getSetting(db, "dns_provider", "") || "null"); } catch { return null; } };
  const maskedProvider = () => { const p = saved(); return p ? { kind: p.kind, teamId: p.teamId ?? "", tokenTail: String(p.token).slice(-4) } : null; };

  async function ipNow() {
    const fixed = (publicIp?.() ?? "").trim();
    if (fixed) return fixed;
    try {
      const r = await fetchImpl("https://api.ipify.org", { signal: AbortSignal.timeout(5000) });
      return (await r.text()).trim();
    } catch { return ""; }
  }

  // Every hostname Console knows about, with what each needs.
  async function hosts() {
    const ip = await ipNow();
    const out = [];
    const join = getSetting(db, "join_domain", "");
    const server = listServers(db).find((s) => mcRoot(s));
    if (join && server) out.push({ host: join, role: "Minecraft join address", records: wantedRecords({ host: join, ip, port: await mc.portOf(server), minecraft: true }) });
    for (const s of siteHosts()) out.push({ host: s.host, role: s.role ?? "Website", records: wantedRecords({ host: s.host, ip }) });
    return { ip, hosts: out };
  }
  const siteHosts = () => { try { return JSON.parse(getSetting(db, "sites", "[]")).map((x) => ({ host: x.host, role: x.role })); } catch { return []; } };

  app.get("/api/dns", { preHandler: need("admin") }, wrap(async () => {
    const h = await hosts();
    const first = h.hosts[0]?.host ?? getSetting(db, "join_domain", "");
    return { ...h, provider: maskedProvider(), guess: first ? await guess(first) : null };
  }));

  app.get("/api/dns/check", { preHandler: need("admin") }, wrap(async () => {
    const h = await hosts();
    const checked = await Promise.all(h.hosts.map(async (x) => ({ host: x.host, records: await Promise.all(x.records.map(async (r) => ({ ...r, check: await check(r) }))) })));
    return { hosts: checked, allGood: checked.every((x) => x.records.every((r) => r.check.state === "ok")) && checked.length > 0 };
  }));

  app.put("/api/dns/provider", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const { kind, token, teamId = "" } = req.body ?? {};
    if (!["cloudflare", "vercel"].includes(kind)) throw new DnsError("Pick Cloudflare or Vercel");
    const t = String(token ?? "").trim();
    if (t.length < 10 || t.length > 400 || /\s/.test(t)) throw new DnsError("That doesn't look like an API token");
    if (teamId && !/^[A-Za-z0-9_]{3,64}$/.test(String(teamId))) throw new DnsError("Team ID looks wrong (starts with team_)");
    await providerFor(kind, { token: t, teamId, fetchImpl }).verify(); // refuse a token that doesn't work
    setSetting(db, "dns_provider", JSON.stringify({ kind, token: t, teamId }));
    audit(db, { username: req.user.username, action: "dns_provider", ok: true, detail: kind });
    return maskedProvider();
  }));
  app.delete("/api/dns/provider", { preHandler: need("admin") }, async (req) => {
    setSetting(db, "dns_provider", "");
    audit(db, { username: req.user.username, action: "dns_provider", ok: true, detail: "removed" });
    return { ok: true };
  });

  app.post("/api/dns/apply", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const p = saved();
    if (!p) throw new DnsError("Save a DNS provider token first");
    const provider = providerFor(p.kind, { token: p.token, teamId: p.teamId, fetchImpl });
    const h = await hosts();
    if (!h.hosts.length) throw new DnsError("There's no domain set yet. Add one first.");
    const results = [];
    for (const x of h.hosts) {
      for (const r of x.records) {
        try { results.push({ host: x.host, type: r.type, action: await provider.upsert(r) }); }
        catch (e) { results.push({ host: x.host, type: r.type, error: e.message }); }
      }
    }
    audit(db, { username: req.user.username, action: "dns_apply", ok: results.every((r) => !r.error), detail: results.map((r) => `${r.type} ${r.host}: ${r.action ?? "failed"}`).join("; ").slice(0, 400) });
    return { results };
  }));
}
