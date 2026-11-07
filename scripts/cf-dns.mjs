#!/usr/bin/env node
// Point a hostname at this server by creating or updating a DNS record on Cloudflare.
//
//   CF_API_TOKEN=xxxx node scripts/cf-dns.mjs console.example.com 203.0.113.10
//
// The token needs: Zone > Zone > Read and Zone > DNS > Edit for the zone ("Edit zone DNS" template).
// It is read from the environment only. It is never printed or written anywhere.
// Records are created DNS-only (grey cloud) so Caddy can get its HTTPS certificate directly.
// Set CF_PROXIED=1 to turn the Cloudflare proxy on instead.
import { pathToFileURL } from "node:url";

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const V6_RE = /^[0-9a-f:]{2,45}$/i;

export function validIp(ip) {
  const m = V4_RE.exec(ip);
  if (m) return m.slice(1).every((o) => Number(o) <= 255);
  return ip.includes(":") && V6_RE.test(ip);
}

export async function upsertDns({
  name,
  ip,
  token,
  base = "https://api.cloudflare.com/client/v4",
  proxied = false,
  fetchImpl = fetch,
}) {
  name = String(name ?? "").toLowerCase();
  if (!HOST_RE.test(name)) throw new Error(`"${name}" is not a valid hostname`);
  if (!validIp(String(ip ?? ""))) throw new Error(`"${ip}" is not a valid IP address`);
  if (!token) throw new Error("No Cloudflare API token given");

  async function cf(method, path, body) {
    const res = await fetchImpl(base + path, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`Cloudflare sent a response that wasn't JSON (HTTP ${res.status})`);
    }
    if (!json.success) {
      const msg = (json.errors ?? []).map((e) => `${e.message}${e.code ? ` (code ${e.code})` : ""}`).join("; ");
      throw new Error(msg || `Cloudflare request failed (HTTP ${res.status})`);
    }
    return json.result;
  }

  // console.example.com -> try console.example.com, then example.com. The first one that is a zone wins.
  const labels = name.split(".");
  let zone = null;
  for (let i = 0; i < labels.length - 1 && !zone; i++) {
    const found = await cf("GET", `/zones?name=${encodeURIComponent(labels.slice(i).join("."))}`);
    if (found.length) zone = found[0];
  }
  if (!zone) {
    throw new Error(
      `No Cloudflare zone found for ${name}. The domain must be on the Cloudflare account this token belongs to, and the token needs Zone:Read.`
    );
  }

  const type = ip.includes(":") ? "AAAA" : "A";
  const existing = await cf("GET", `/zones/${zone.id}/dns_records?type=${type}&name=${encodeURIComponent(name)}`);
  const result = { type, name, ip, zone: zone.name, proxied };

  if (existing.length) {
    const rec = existing[0];
    if (rec.content === ip && Boolean(rec.proxied) === proxied) return { ...result, action: "unchanged" };
    await cf("PATCH", `/zones/${zone.id}/dns_records/${rec.id}`, { content: ip, proxied, ttl: 1 });
    return { ...result, action: "updated" };
  }
  await cf("POST", `/zones/${zone.id}/dns_records`, {
    type,
    name,
    content: ip,
    ttl: 1,
    proxied,
    comment: "Created by the Console installer",
  });
  return { ...result, action: "created" };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [name, ip] = process.argv.slice(2);
  if (!name || !ip) {
    console.error("usage: CF_API_TOKEN=... node scripts/cf-dns.mjs <hostname> <ip>");
    process.exit(2);
  }
  try {
    const r = await upsertDns({
      name,
      ip,
      token: process.env.CF_API_TOKEN,
      base: process.env.CF_API_BASE || undefined,
      proxied: process.env.CF_PROXIED === "1",
    });
    const mode = r.proxied ? "proxied" : "DNS only";
    console.log(`${r.action} ${r.type} record ${r.name} -> ${r.ip} (zone ${r.zone}, ${mode})`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
