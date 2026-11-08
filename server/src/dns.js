import { Resolver } from "node:dns/promises";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
export const validHost = (h) => HOST_RE.test(String(h ?? "").toLowerCase());
export const validIp4 = (ip) => {
  const m = V4_RE.exec(String(ip ?? ""));
  return Boolean(m) && m.slice(1).every((o) => Number(o) <= 255);
};

export class DnsError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// What a host needs so that players (and browsers) can find this machine.
export function wantedRecords({ host, ip, port = 25565, minecraft = false }) {
  host = String(host).toLowerCase();
  if (!validHost(host)) throw new DnsError(`"${host}" doesn't look like a domain name`);
  if (!validIp4(ip)) throw new DnsError("This machine's public IP isn't known yet");
  const out = [{ type: "A", name: host, value: ip, ttl: 300, note: "Points this name at your server." }];
  if (minecraft && port !== 25565) {
    out.push({ type: "SRV", name: `_minecraft._tcp.${host}`, value: `0 5 ${port} ${host}`, srv: { priority: 0, weight: 5, port, target: host }, ttl: 300, note: "Lets players join without typing the port." });
  }
  return out;
}

// Asks public resolvers (not this machine's cache) so "it works for me" means it works for everyone.
export function createChecker({ resolver = null } = {}) {
  const r = resolver ?? (() => { const x = new Resolver({ timeout: 4000, tries: 1 }); x.setServers(["1.1.1.1", "8.8.8.8"]); return x; })();
  return async function check(rec) {
    try {
      if (rec.type === "A") {
        const got = await r.resolve4(rec.name);
        return got.includes(rec.value) ? { state: "ok" } : { state: "wrong", found: got.join(", ") };
      }
      if (rec.type === "SRV") {
        const got = await r.resolveSrv(rec.name);
        const hit = got.some((g) => g.port === rec.srv.port && String(g.name).replace(/\.$/, "") === rec.srv.target);
        return hit ? { state: "ok" } : { state: "wrong", found: got.map((g) => `${g.port} ${g.name}`).join(", ") };
      }
    } catch (e) {
      return { state: ["ENOTFOUND", "ENODATA"].includes(e.code) ? "missing" : "error", error: e.code ?? e.message };
    }
    return { state: "error" };
  };
}

// Which company runs this domain's DNS, so the page can say "paste a token from X" instead of guessing.
export async function guessProvider(host, { resolver = null } = {}) {
  const r = resolver ?? (() => { const x = new Resolver({ timeout: 4000, tries: 1 }); x.setServers(["1.1.1.1", "8.8.8.8"]); return x; })();
  const labels = String(host).toLowerCase().split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    try {
      const ns = (await r.resolveNs(labels.slice(i).join("."))).map((x) => x.toLowerCase());
      const has = (s) => ns.some((n) => n.includes(s));
      const kind = has("cloudflare") ? "cloudflare" : has("vercel-dns") ? "vercel" : null;
      const name = kind === "cloudflare" ? "Cloudflare" : kind === "vercel" ? "Vercel" : has("godaddy") || has("domaincontrol") ? "GoDaddy" : has("namecheap") || has("registrar-servers") ? "Namecheap" : has("google") ? "Google Domains / Squarespace" : has("porkbun") ? "Porkbun" : null;
      return { zone: labels.slice(i).join("."), nameservers: ns, kind, name };
    } catch { /* try the parent domain */ }
  }
  return { zone: null, nameservers: [], kind: null, name: null };
}

// ---- providers that can add the records for you ----
async function call(fetchImpl, url, init, label) {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok || body?.success === false) {
    const msg = body?.errors?.map((e) => e.message).join("; ") || body?.error?.message || `${label} answered ${res.status}`;
    throw new DnsError(`${label}: ${msg}`, res.status === 401 || res.status === 403 ? 400 : 502);
  }
  return body;
}

export function createProvider(kind, { token, teamId = "", fetchImpl = fetch, base } = {}) {
  if (!token) throw new DnsError("No API token saved");
  const labels = (host) => host.split(".");

  if (kind === "cloudflare") {
    const api = base ?? "https://api.cloudflare.com/client/v4";
    const cf = async (method, path, body) => (await call(fetchImpl, api + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, "Cloudflare")).result;
    const zoneFor = async (host) => {
      const l = labels(host);
      for (let i = 0; i < l.length - 1; i++) {
        const found = await cf("GET", `/zones?name=${encodeURIComponent(l.slice(i).join("."))}`);
        if (found.length) return found[0];
      }
      throw new DnsError(`No Cloudflare zone for ${host}. The domain must be on the Cloudflare account this token belongs to.`);
    };
    return {
      kind,
      verify: async () => { await cf("GET", "/user/tokens/verify"); return true; },
      async upsert(rec) {
        const zone = await zoneFor(rec.name);
        const payload = rec.type === "SRV"
          ? { type: "SRV", name: rec.name, ttl: 1, data: { priority: rec.srv.priority, weight: rec.srv.weight, port: rec.srv.port, target: rec.srv.target } }
          : { type: rec.type, name: rec.name, content: rec.value, ttl: 1, proxied: false };
        const existing = await cf("GET", `/zones/${zone.id}/dns_records?type=${rec.type}&name=${encodeURIComponent(rec.name)}`);
        if (existing.length) {
          const e = existing[0];
          const same = rec.type === "A" ? e.content === rec.value && !e.proxied : e.data?.port === rec.srv.port && String(e.data?.target).replace(/\.$/, "") === rec.srv.target;
          if (same) return "unchanged";
          await cf("PATCH", `/zones/${zone.id}/dns_records/${e.id}`, payload);
          return "updated";
        }
        await cf("POST", `/zones/${zone.id}/dns_records`, { ...payload, comment: "Created by Console" });
        return "created";
      },
    };
  }

  if (kind === "vercel") {
    const api = base ?? "https://api.vercel.com";
    const q = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const qa = teamId ? `&teamId=${encodeURIComponent(teamId)}` : "";
    const vc = (method, path, body) => call(fetchImpl, api + path, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }, "Vercel");
    const domainFor = async (host) => {
      const l = labels(host);
      for (let i = 0; i < l.length - 1; i++) {
        const d = l.slice(i).join(".");
        try { await vc("GET", `/v5/domains/${encodeURIComponent(d)}${q}`); return d; } catch (e) { if (e.status !== 502 && e.status !== 400) throw e; }
      }
      throw new DnsError(`${host} isn't a domain on this Vercel account (or team). If it's on a team, save the team ID too.`);
    };
    return {
      kind,
      verify: async () => { await vc("GET", `/v2/user${q}`); return true; },
      async upsert(rec) {
        const domain = await domainFor(rec.name);
        const rel = rec.name === domain ? "" : rec.name.slice(0, -(domain.length + 1));
        const list = (await vc("GET", `/v4/domains/${encodeURIComponent(domain)}/records?limit=200${qa}`)).records ?? [];
        const e = list.find((r) => r.type === rec.type && (r.name ?? "") === rel);
        if (e) {
          const same = rec.type === "A" ? e.value === rec.value : String(e.value).includes(` ${rec.srv.port} `) || e.srv?.port === rec.srv.port;
          if (same) return "unchanged";
          await vc("PATCH", `/v1/domains/records/${encodeURIComponent(e.id)}${q}`, rec.type === "A" ? { value: rec.value } : { srv: rec.srv });
          return "updated";
        }
        const body = rec.type === "SRV" ? { name: rel, type: "SRV", srv: rec.srv, ttl: 60 } : { name: rel, type: rec.type, value: rec.value, ttl: 60 };
        await vc("POST", `/v2/domains/${encodeURIComponent(domain)}/records${q}`, body);
        return "created";
      },
    };
  }
  throw new DnsError("Unknown DNS provider");
}
