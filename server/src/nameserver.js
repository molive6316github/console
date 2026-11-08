import dgram from "node:dgram";
import net from "node:net";
import { getSetting, setSetting } from "./db.js";
import { validHost, validIp4 } from "./dns.js";

export class NsError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const T = { A: 1, NS: 2, CNAME: 5, SOA: 6, MX: 15, TXT: 16, SRV: 33, ANY: 255 };
const RC = { OK: 0, FORMERR: 1, NXDOMAIN: 3, NOTIMP: 4, REFUSED: 5 };

const encName = (name) => Buffer.concat([...String(name).replace(/\.$/, "").split("."), ""].map((l) => (l ? Buffer.concat([Buffer.from([l.length]), Buffer.from(l)]) : Buffer.from([0]))));
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

// ---- wire format ----
export function parseQuery(buf) {
  if (buf.length < 17) return null;
  const id = buf.readUInt16BE(0), flags = buf.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  const qd = buf.readUInt16BE(4);
  if (qd !== 1) return { id, flags, error: RC.FORMERR };
  const labels = [];
  let o = 12;
  for (;;) {
    const len = buf[o];
    if (len === undefined || len > 63 || (len & 0xc0)) return { id, flags, error: RC.FORMERR };
    if (len === 0) { o++; break; }
    labels.push(buf.toString("ascii", o + 1, o + 1 + len).toLowerCase());
    o += len + 1;
    if (o > buf.length) return { id, flags, error: RC.FORMERR };
  }
  if (o + 4 > buf.length) return { id, flags, error: RC.FORMERR };
  return { id, flags, opcode: (flags >> 11) & 0xf, name: labels.join("."), type: buf.readUInt16BE(o), cls: buf.readUInt16BE(o + 2), qEnd: o + 4 };
}

function rr(owner, type, ttl, rdata) {
  return Buffer.concat([owner === null ? Buffer.from([0xc0, 0x0c]) : encName(owner), u16(type), u16(1), u32(ttl), u16(rdata.length), rdata]);
}
const rdA = (ip) => Buffer.from(ip.split(".").map(Number));
const rdSoa = (z) => Buffer.concat([encName(z.mname), encName(z.rname), u32(z.serial), u32(3600), u32(600), u32(86400), u32(300)]);

export function buildResponse(q, buf, { rcode = 0, aa = true, answers = [], authority = [] }) {
  const head = Buffer.alloc(12);
  head.writeUInt16BE(q.id, 0);
  head.writeUInt16BE(0x8000 | (aa ? 0x0400 : 0) | (q.flags & 0x0100) | rcode, 2);
  head.writeUInt16BE(1, 4);
  head.writeUInt16BE(answers.length, 6);
  head.writeUInt16BE(authority.length, 8);
  const out = Buffer.concat([head, buf.subarray(12, q.qEnd), ...answers, ...authority]);
  if (out.length > 512) { // too big for plain UDP: send the header with the truncated flag, client retries over TCP
    const t = Buffer.concat([head, buf.subarray(12, q.qEnd)]);
    t.writeUInt16BE(t.readUInt16BE(2) | 0x0200, 2); t.writeUInt16BE(0, 6); t.writeUInt16BE(0, 8);
    return t;
  }
  return out;
}

const labelsOf = (n) => n.split(".");
const under = (name, zone) => name === zone || name.endsWith(`.${zone}`);

// ---- what we answer ----
export function createAuthority({ getConfig }) {
  function zoneOf(name, zones) {
    return zones.filter((z) => under(name, z)).sort((a, b) => b.length - a.length)[0] ?? null;
  }
  function answer(q, buf) {
    const cfg = getConfig();
    if (q.error) return buildResponse({ id: q.id, flags: q.flags, qEnd: 12 }, buf, { rcode: q.error, aa: false });
    if (q.opcode !== 0) return buildResponse(q, buf, { rcode: RC.NOTIMP, aa: false });
    if (q.cls !== 1) return buildResponse(q, buf, { rcode: RC.REFUSED, aa: false });
    const zone = cfg.enabled ? zoneOf(q.name, cfg.zones) : null;
    if (!zone) return buildResponse(q, buf, { rcode: RC.REFUSED, aa: false });

    const ttl = 300;
    const nsNames = cfg.nsNames(zone);
    const soa = rr(zone, T.SOA, 300, rdSoa({ mname: nsNames[0], rname: `hostmaster.${zone}`, serial: cfg.serial }));
    const names = new Map(); // name -> [{type, rd}]
    const put = (name, type, rd) => { name = name.toLowerCase(); if (!names.has(name)) names.set(name, []); names.get(name).push({ type, rd }); };
    for (const n of nsNames) put(zone, T.NS, encName(n));
    for (const n of nsNames) if (under(n, zone) && validIp4(cfg.ip)) put(n, T.A, rdA(cfg.ip));
    for (const h of cfg.hosts) {
      if (!under(h.name, zone)) continue;
      if (validIp4(cfg.ip)) put(h.name, T.A, rdA(cfg.ip));
      if (h.srvPort && h.srvPort !== 25565) put(`_minecraft._tcp.${h.name}`, T.SRV, Buffer.concat([u16(0), u16(5), u16(h.srvPort), encName(h.name)]));
    }
    for (const e of cfg.extra) {
      if (!under(e.name, zone)) continue;
      if (e.type === "A" && validIp4(e.value)) put(e.name, T.A, rdA(e.value));
      else if (e.type === "CNAME") { put(e.name, T.CNAME, encName(e.value)); names.get(e.name.toLowerCase()).at(-1).target = e.value; }
      else if (e.type === "TXT") { const b = Buffer.from(e.value.slice(0, 255)); put(e.name, T.TXT, Buffer.concat([Buffer.from([b.length]), b])); }
      else if (e.type === "MX") { const [pri, host] = e.value.split(/\s+/); put(e.name, T.MX, Buffer.concat([u16(Number(pri)), encName(host)])); }
    }
    put(zone, T.SOA, null);

    const here = names.get(q.name) ?? [];
    const cname = here.find((r) => r.type === T.CNAME);
    const wanted = q.type === T.ANY ? here.filter((r) => r.type !== T.SOA && r.rd) : here.filter((r) => r.type === q.type && r.rd);
    if (q.type === T.SOA && q.name === zone) return buildResponse(q, buf, { answers: [soa] });
    if (cname && q.type !== T.CNAME) {
      // A CNAME to a name we also serve: include the target's addresses so the client doesn't need a second trip.
      const target = cname.name ?? null;
      const tname = (cname.target ?? "").toLowerCase();
      const extra = q.type === T.A && tname ? (names.get(tname) ?? []).filter((r) => r.type === T.A).map((r) => rr(tname, T.A, ttl, r.rd)) : [];
      void target;
      return buildResponse(q, buf, { answers: [rr(null, T.CNAME, ttl, cname.rd), ...extra] });
    }
    if (wanted.length) return buildResponse(q, buf, { answers: wanted.map((r) => rr(null, r.type, ttl, r.rd)) });
    const exists = here.length > 0 || [...names.keys()].some((n) => n.endsWith(`.${q.name}`));
    return buildResponse(q, buf, { rcode: exists ? RC.OK : RC.NXDOMAIN, authority: [soa] });
  }
  return { answer };
}

// ---- sockets ----
export function createNameserverServer({ authority, port = 53, address = "0.0.0.0", maxPerSecond = 80 }) {
  let udp = null, tcp = null;
  const hits = new Map();
  let tick = null;
  const limited = (ip) => { const n = (hits.get(ip) ?? 0) + 1; hits.set(ip, n); return n > maxPerSecond; };

  async function start() {
    if (udp) return { listening: true, port: udp.address().port };
    const u = dgram.createSocket("udp4");
    await new Promise((res, rej) => { u.once("error", rej); u.bind(port, address, () => { u.off("error", rej); res(); }); });
    u.on("error", () => {});
    u.on("message", (msg, rinfo) => {
      if (limited(rinfo.address)) return;
      let q; try { q = parseQuery(msg); if (!q) return; u.send(authority.answer(q, msg), rinfo.port, rinfo.address); } catch { /* malformed: ignore */ }
    });
    udp = u;
    try {
      const t = net.createServer((sock) => {
        sock.setTimeout(5000, () => sock.destroy());
        let acc = Buffer.alloc(0);
        sock.on("error", () => {});
        sock.on("data", (d) => {
          acc = Buffer.concat([acc, d]);
          if (acc.length > 4096) return sock.destroy();
          while (acc.length >= 2 && acc.length >= 2 + acc.readUInt16BE(0)) {
            const len = acc.readUInt16BE(0), msg = acc.subarray(2, 2 + len);
            acc = acc.subarray(2 + len);
            if (limited(sock.remoteAddress ?? "tcp")) return sock.destroy();
            try { const q = parseQuery(msg); if (q) { const r = authority.answer(q, msg); sock.write(Buffer.concat([u16(r.length), r])); } } catch { sock.destroy(); }
          }
        });
      });
      await new Promise((res, rej) => { t.once("error", rej); t.listen(port === 0 ? udp.address().port : port, address, () => { t.off("error", rej); res(); }); });
      tcp = t;
    } catch (e) { u.close(); udp = null; throw e; }
    tick = setInterval(() => hits.clear(), 1000); tick.unref?.();
    return { listening: true, port: udp.address().port };
  }
  async function stop() {
    clearInterval(tick);
    await Promise.all([udp && new Promise((r) => udp.close(r)), tcp && new Promise((r) => tcp.close(r))]);
    udp = tcp = null;
  }
  return { start, stop, listening: () => Boolean(udp) };
}

// ---- configuration ----
const registrableLen = (zone) => (/\.(co|com|org|net|ac|gov)\.[a-z]{2}$/.test(zone) ? 3 : 2);
export const isWholeDomain = (zone) => labelsOf(zone).length <= registrableLen(zone);

export function createNsConfig({ db, knownHosts, publicIp, now = () => Date.now() }) {
  const raw = () => { try { return { enabled: false, zones: [], extra: [], serial: 1, ...(JSON.parse(getSetting(db, "ns", "{}"))) }; } catch { return { enabled: false, zones: [], extra: [], serial: 1 }; } };
  // A whole domain gets ns1/ns2 inside it. A delegated sub-name points at one shared name under the parent domain.
  const nsNamesFor = (zone) => {
    if (isWholeDomain(zone)) return [`ns1.${zone}`, `ns2.${zone}`];
    const parent = labelsOf(zone).slice(-registrableLen(zone)).join(".");
    return [`ns1.${parent}`];
  };
  function get() {
    const c = raw();
    return { enabled: c.enabled, zones: c.zones, extra: c.extra, serial: c.serial, ip: publicIp() || "", hosts: knownHosts(), nsNames: nsNamesFor };
  }
  function set(patch) {
    const c = raw();
    const next = { ...c };
    if (patch.zones !== undefined) {
      const zs = [...new Set((Array.isArray(patch.zones) ? patch.zones : []).map((z) => String(z).trim().toLowerCase().replace(/\.$/, "")).filter(Boolean))];
      for (const z of zs) if (!validHost(z)) throw new NsError(`"${z}" doesn't look like a domain name`);
      if (zs.length > 20) throw new NsError("That's a lot of domains (20 max)");
      next.zones = zs;
    }
    if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
    if (patch.extra !== undefined) {
      const list = Array.isArray(patch.extra) ? patch.extra : [];
      if (list.length > 200) throw new NsError("Too many extra records");
      next.extra = list.map((e) => {
        const type = String(e.type).toUpperCase(), name = String(e.name).trim().toLowerCase().replace(/\.$/, ""), value = String(e.value).trim();
        if (!["A", "CNAME", "TXT", "MX"].includes(type)) throw new NsError("Extra records can be A, CNAME, TXT or MX");
        if (!validHost(name)) throw new NsError(`"${name}" isn't a valid name`);
        if (type === "A" && !validIp4(value)) throw new NsError(`${name}: A needs an IPv4 address`);
        if (type === "CNAME" && !validHost(value.replace(/\.$/, ""))) throw new NsError(`${name}: CNAME needs a hostname`);
        if (type === "MX" && !/^\d{1,5}\s+[A-Za-z0-9.-]+$/.test(value)) throw new NsError(`${name}: MX looks like "10 mail.example.com"`);
        if (type === "TXT" && (value.length > 255 || /[\r\n\0]/.test(value))) throw new NsError(`${name}: TXT is too long`);
        return { type, name, value: type === "CNAME" || type === "MX" ? value.replace(/\.$/, "") : value };
      });
    }
    next.serial = Math.floor(now() / 1000);
    setSetting(db, "ns", JSON.stringify(next));
    return get();
  }
  return { get, set, nsNamesFor };
}

// What the person has to do at their registrar / current DNS provider, once.
export function delegationSteps(zone, ip, nsNames) {
  if (isWholeDomain(zone)) {
    return {
      kind: "registrar",
      title: `Make Console the nameserver for ${zone}`,
      steps: [
        `At the company you bought ${zone} from, find "Nameservers" (sometimes "Custom DNS").`,
        `First create these two "glue" / "host" records, both pointing at ${ip}: ${nsNames.join(" and ")}. (GoDaddy: Host names. Namecheap: Personal DNS server. Porkbun: Glue records. Cloudflare Registrar and Vercel: set custom nameservers, which creates the glue.)`,
        `Then set the domain's nameservers to: ${nsNames.join(" and ")}.`,
        "It can take from a few minutes up to a day to spread. Console checks it for you.",
      ],
      records: [],
    };
  }
  const parent = zone.split(".").slice(-2).join(".");
  return {
    kind: "records",
    title: `Hand ${zone} to Console`,
    steps: [`Where ${parent} is managed today, add these two records. Everything else on ${parent} stays exactly as it is.`],
    records: [
      { type: "NS", name: zone, value: nsNames[0], ttl: 300, note: `Says "Console answers for ${zone}".` },
      { type: "A", name: nsNames[0], value: ip, ttl: 300, note: "Where that nameserver lives (only needed once per domain)." },
    ],
  };
}
