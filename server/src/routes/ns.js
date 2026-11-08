import process from "node:process";
import { Resolver } from "node:dns/promises";
import { audit, getSetting, listServers } from "../db.js";
import { mcRoot } from "../mc/index.js";
import { NsError, delegationSteps, isWholeDomain } from "../nameserver.js";
import { validIp4 } from "../dns.js";

// Console as its own nameserver: turn it on, hand your domain(s) over once, then names just work.
export function nsRoutes(app, { db, need, mc, safeMode, nsConfig, nsServer, run, publicIp, resolverFor = () => { const r = new Resolver({ timeout: 4000, tries: 1 }); r.setServers(["1.1.1.1", "8.8.8.8"]); return r; } }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof NsError) return reply.code(e.status).send({ error: e.message }); throw e; }
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });

  // The sockets need the host list synchronously, but the game port is async to look up, so keep it fresh in the background.
  let ports = new Map();
  async function refreshPorts() {
    const server = listServers(db).find((s) => mcRoot(s));
    const join = getSetting(db, "join_domain", "");
    if (server && join) { try { ports.set(join, await mc.portOf(server)); } catch { /* keep the old one */ } }
  }
  const timer = setInterval(() => refreshPorts().catch(() => {}), 60_000);
  timer.unref?.();
  refreshPorts().catch(() => {});

  let lastError = null;
  async function ensureRunning() {
    const c = nsConfig.get();
    if (!c.enabled) { await nsServer.stop(); lastError = null; return { listening: false }; }
    try { const r = await nsServer.start(); lastError = null; return r; }
    catch (e) {
      lastError = e;
      throw e;
    }
  }
  // Called once at boot.
  ensureRunning().catch((e) => console.log(`Console DNS couldn't start: ${friendly(e)}`));

  function friendly(e) {
    if (e.code === "EACCES") return "Console isn't allowed to use port 53 yet.";
    if (e.code === "EADDRINUSE") return "Something else on this machine is already using port 53 (on Ubuntu that is usually systemd-resolved).";
    return e.message;
  }

  async function overview() {
    const c = nsConfig.get();
    const ip = c.ip || publicIp?.() || "";
    const zones = c.zones.map((z) => ({ zone: z, whole: isWholeDomain(z), nsNames: c.nsNames(z), ...delegationSteps(z, ip, c.nsNames(z)) }));
    return { enabled: c.enabled, listening: nsServer.listening(), problem: lastError ? friendly(lastError) : null, ip, zones, extra: c.extra, hosts: c.hosts.map((h) => h.name) };
  }

  app.get("/api/ns", { preHandler: need("admin") }, wrap(overview));

  app.put("/api/ns", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const b = req.body ?? {};
    if (b.enabled === true && !validIp4(nsConfig.get().ip)) throw new NsError("This machine's public IP isn't known yet, so Console can't answer for names. Set CONSOLE_PUBLIC_IP or re-run the installer.");
    nsConfig.set({ zones: b.zones, enabled: b.enabled, extra: b.extra });
    await refreshPorts();
    let needsRestart = false, note = null;
    try {
      await ensureRunning();
      if (nsConfig.get().enabled) {
        // Best effort: open the firewall for DNS on this machine.
        for (const proto of ["udp", "tcp"]) await run("sudo", ["-n", "firewall-cmd", "--permanent", `--add-port=53/${proto}`]).catch(() => {});
        await run("sudo", ["-n", "firewall-cmd", "--reload"]).catch(() => {});
        note = "Oracle Cloud also needs an ingress rule for UDP and TCP port 53 (skip if you already allow all ports).";
      }
    } catch (e) {
      if (e.code === "EACCES") {
        // Let node bind low ports without being root, then restart so it takes effect.
        const r = await run("sudo", ["-n", "setcap", "cap_net_bind_service=+ep", await realNode()]);
        if (r.code === 0) needsRestart = true;
        else throw new NsError("Console isn't allowed to use port 53 and couldn't grant itself that (it needs passwordless sudo). Re-run the installer: sudo mxt-console run");
      } else throw new NsError(friendly(e), 409);
    }
    audit(db, { username: req.user.username, action: "ns_config", ok: true, detail: `${nsConfig.get().enabled ? "on" : "off"}: ${nsConfig.get().zones.join(", ")}` });
    return { ...(await overview()), needsRestart, note };
  }));

  app.get("/api/ns/check", { preHandler: need("admin") }, wrap(async () => {
    const c = nsConfig.get();
    const r = resolverFor();
    const out = [];
    for (const z of c.zones) {
      const want = c.nsNames(z);
      let got = [];
      try { got = (await r.resolveNs(z)).map((x) => x.toLowerCase()); } catch { /* not delegated yet */ }
      const delegated = want.every((n) => got.includes(n)) && got.length > 0;
      const hosts = [];
      for (const h of c.hosts.filter((x) => x.name === z || x.name.endsWith(`.${z}`))) {
        let ips = [];
        try { ips = await r.resolve4(h.name); } catch { /* none */ }
        hosts.push({ host: h.name, ok: ips.includes(c.ip), found: ips.join(", ") });
      }
      out.push({ zone: z, delegated, found: got, hosts });
    }
    return { zones: out };
  }));

  async function realNode() {
    const { realpathSync } = await import("node:fs");
    return realpathSync(process.execPath);
  }

  return { ensureRunning, hostsRefresh: () => ports, portOfHost: (h) => ports.get(h) };
}
