import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { getSetting, setSetting } from "./db.js";

export class OffsiteError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha = (s) => createHash("sha256").update(s).digest("hex");
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// AWS Signature V4 for S3-compatible storage (Oracle Object Storage, Backblaze B2, Cloudflare R2, AWS...).
// The body is never read into memory: it's streamed with an unsigned payload hash (allowed over HTTPS).
export function signRequest({ method, url, region, accessKey, secretKey, now = new Date(), payloadHash = "UNSIGNED-PAYLOAD", headers = {} }) {
  const u = new URL(url);
  const amz = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const day = amz.slice(0, 8);
  const h = { host: u.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amz, ...headers };
  const names = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const canonHeaders = names.map((k) => `${k}:${String(h[Object.keys(h).find((x) => x.toLowerCase() === k)]).trim()}\n`).join("");
  const query = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${enc(k)}=${enc(v)}`).join("&");
  const canonPath = u.pathname.split("/").map((s) => enc(decodeURIComponent(s))).join("/");
  const canonical = [method, canonPath, query, canonHeaders, names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amz, scope, sha(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), "s3"), "aws4_request");
  const sig = createHmac("sha256", key).update(toSign).digest("hex");
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}` };
}

const clean = (s, max = 200) => String(s ?? "").trim().slice(0, max);

export function createOffsite({ db, backups, fetchImpl = fetch, now = () => new Date() }) {
  const load = () => { try { return JSON.parse(getSetting(db, "offsite", "") || "null"); } catch { return null; } };
  const configured = () => Boolean(load()?.bucket);

  function view() {
    const c = load();
    return c ? { configured: true, endpoint: c.endpoint, region: c.region, bucket: c.bucket, prefix: c.prefix, keep: c.keep, accessKeyTail: String(c.accessKey).slice(-4) } : { configured: false };
  }

  function validate(b) {
    const endpoint = clean(b.endpoint, 300).replace(/\/+$/, "");
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(endpoint)) throw new OffsiteError("Endpoint must look like https://objectstorage.us-ashburn-1.oraclecloud.com (https, no path)");
    const host = new URL(endpoint).hostname;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || !host.includes(".")) throw new OffsiteError("That endpoint points at a private address");
    const bucket = clean(b.bucket, 63);
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket)) throw new OffsiteError("Bucket name looks wrong");
    const region = clean(b.region, 40) || "us-east-1";
    if (!/^[a-z0-9-]{2,40}$/.test(region)) throw new OffsiteError("Region looks wrong (like us-ashburn-1)");
    const accessKey = clean(b.accessKey, 128), secretKey = clean(b.secretKey, 256);
    if (accessKey.length < 8 || secretKey.length < 8 || /\s/.test(accessKey + secretKey)) throw new OffsiteError("Access key and secret key are both required");
    const prefix = clean(b.prefix ?? "console-backups", 80).replace(/^\/+|\/+$/g, "");
    if (!/^[A-Za-z0-9._/-]*$/.test(prefix)) throw new OffsiteError("Folder name can only use letters, numbers and . _ - /");
    const keep = Math.min(Math.max(parseInt(b.keep, 10) || 14, 1), 365);
    return { endpoint, bucket, region, accessKey, secretKey, prefix, keep };
  }

  const objectUrl = (c, key) => `${c.endpoint}/${c.bucket}/${key.split("/").map(enc).join("/")}`;

  async function send(c, method, url, { body, headers = {}, length } = {}) {
    const signed = signRequest({ method, url, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey, now: now(), headers });
    const { host: _h, ...rest } = signed;
    const res = await fetchImpl(url, { method, headers: { ...rest, ...(length !== undefined ? { "content-length": String(length) } : {}) }, body, duplex: body ? "half" : undefined, signal: AbortSignal.timeout(30 * 60_000) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
      throw new OffsiteError(`Storage answered ${res.status}${code ? ` (${code})` : ""}. ${res.status === 403 ? "Check the keys and the region." : res.status === 404 ? "Check the bucket name and endpoint." : ""}`.trim(), 502);
    }
    return res;
  }

  async function save(body) {
    const prev = load();
    const c = validate({ ...body, secretKey: body.secretKey || prev?.secretKey });
    await test(c);
    setSetting(db, "offsite", JSON.stringify(c));
    return view();
  }

  async function test(c = load()) {
    if (!c) throw new OffsiteError("Off-box backups aren't set up yet");
    const key = `${c.prefix ? `${c.prefix}/` : ""}console-test.txt`;
    const text = Buffer.from(`Console connection test ${now().toISOString()}\n`);
    await send(c, "PUT", objectUrl(c, key), { body: text, length: text.length, headers: { "content-type": "text/plain" } });
    await send(c, "DELETE", objectUrl(c, key));
    return { ok: true };
  }

  async function upload(serverId, name) {
    const c = load();
    if (!c) return { uploaded: false };
    const file = backups.pathFor(serverId, name);
    if (!file) throw new OffsiteError("That backup file doesn't exist");
    const size = (await stat(file)).size;
    const key = `${c.prefix ? `${c.prefix}/` : ""}${serverId}/${name}`;
    await send(c, "PUT", objectUrl(c, key), { body: Readable.toWeb(createReadStream(file)), length: size, headers: { "content-type": "application/gzip" } });
    await prune(c, serverId).catch(() => {});
    return { uploaded: true, key, size };
  }

  // Keep the newest `keep` copies of this server's backups.
  async function prune(c, serverId) {
    const prefix = `${c.prefix ? `${c.prefix}/` : ""}${serverId}/`;
    const url = `${c.endpoint}/${c.bucket}?list-type=2&prefix=${enc(prefix)}`;
    const xml = await (await send(c, "GET", url)).text();
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]).filter((k) => /\d{8}T\d{6}Z\.tar\.gz$/.test(k)).sort().reverse();
    for (const k of keys.slice(c.keep)) await send(c, "DELETE", objectUrl(c, k));
    return keys.length;
  }

  return { view, save, test: () => test(), upload, configured, remove: () => setSetting(db, "offsite", "") };
}
