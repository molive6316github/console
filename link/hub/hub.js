import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

// What a dashboard user may ask a server to do. The plugin re-checks this list, so a bug here can't turn into console access.
const NAME = /^[A-Za-z0-9_]{1,16}$/;
export const COMMANDS = {
  "whitelist-add": (a) => NAME.test(a.player ?? "") && `whitelist add ${a.player}`,
  "whitelist-remove": (a) => NAME.test(a.player ?? "") && `whitelist remove ${a.player}`,
  op: (a) => NAME.test(a.player ?? "") && `op ${a.player}`,
  deop: (a) => NAME.test(a.player ?? "") && `deop ${a.player}`,
  kick: (a) => NAME.test(a.player ?? "") && `kick ${a.player}`,
  say: (a) => typeof a.message === "string" && /^[^\n\r\/§]{1,200}$/.test(a.message) && `say ${a.message}`,
};

const sha = (s) => createHash("sha256").update(s).digest("hex");
const clean = (s, n) => (typeof s === "string" ? s.replace(/[\u0000-\u001f]/g, "").slice(0, n) : "");

export function createHub({ dbPath = ":memory:", adminToken, now = () => Date.now(), maxBody = 64 * 1024, perMinute = 30, staleMs = 90_000 } = {}) {
  if (!adminToken || adminToken.length < 16) throw new Error("adminToken (16+ chars) is required");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, is_public INTEGER NOT NULL DEFAULT 0, show_names INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, snap TEXT, snap_at INTEGER);
    CREATE TABLE IF NOT EXISTS commands (id INTEGER PRIMARY KEY AUTOINCREMENT, server_id TEXT NOT NULL, cmd TEXT NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER, done_at INTEGER, result TEXT);
  `);
  const hits = new Map(); // key id -> [timestamps]
  const limited = (id) => { const t = now(), a = (hits.get(id) ?? []).filter((x) => t - x < 60_000); a.push(t); hits.set(id, a); return a.length > perMinute; };

  const bySlug = (id) => db.prepare("SELECT * FROM servers WHERE id = ?").get(id);
  const byKey = (key) => db.prepare("SELECT * FROM servers WHERE key_hash = ?").get(sha(String(key ?? "")));

  function createServer({ id, name, isPublic = false, showNames = false }) {
    if (!/^[a-z0-9-]{2,32}$/.test(id ?? "")) throw new HubError("id must be 2-32 chars: a-z, 0-9, -", 400);
    if (bySlug(id)) throw new HubError("That id is taken", 409);
    const key = "lk_" + randomBytes(24).toString("base64url");
    db.prepare("INSERT INTO servers (id,name,key_hash,is_public,show_names,created_at) VALUES (?,?,?,?,?,?)").run(id, clean(name, 60) || id, sha(key), isPublic ? 1 : 0, showNames ? 1 : 0, now());
    return { id, key }; // the key is shown once, only its hash is stored
  }
  function rotateKey(id) {
    if (!bySlug(id)) throw new HubError("No such server", 404);
    const key = "lk_" + randomBytes(24).toString("base64url");
    db.prepare("UPDATE servers SET key_hash = ? WHERE id = ?").run(sha(key), id);
    return { id, key };
  }
  function queue(id, action, args) {
    if (!bySlug(id)) throw new HubError("No such server", 404);
    const build = COMMANDS[action];
    const cmd = build ? build(args ?? {}) : false;
    if (!cmd) throw new HubError("That action or its arguments aren't allowed", 400);
    const pending = db.prepare("SELECT COUNT(*) n FROM commands WHERE server_id = ? AND done_at IS NULL").get(id).n;
    if (pending >= 50) throw new HubError("Too many commands waiting. Is the server offline?", 429);
    const r = db.prepare("INSERT INTO commands (server_id, cmd, created_at) VALUES (?,?,?)").run(id, cmd, now());
    return { id: Number(r.lastInsertRowid), cmd };
  }

  function ingest(server, body) {
    const players = Array.isArray(body.players) ? body.players.slice(0, 500).map((p) => ({ name: clean(p?.name, 16), uuid: clean(p?.uuid, 36) })).filter((p) => NAME.test(p.name)) : [];
    const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
    const snap = { version: clean(body.version, 40), online: players.length, max: num(body.max), tps: num(body.tps), motd: clean(body.motd, 120), players };
    db.prepare("UPDATE servers SET snap = ?, snap_at = ? WHERE id = ?").run(JSON.stringify(snap), now(), server.id);
    // Acks first, so a command is never handed out twice.
    for (const a of Array.isArray(body.done) ? body.done.slice(0, 50) : []) {
      db.prepare("UPDATE commands SET done_at = ?, result = ? WHERE id = ? AND server_id = ?").run(now(), clean(a?.result, 200), Number(a?.id) || 0, server.id);
    }
    const rows = db.prepare("SELECT id, cmd FROM commands WHERE server_id = ? AND done_at IS NULL ORDER BY id LIMIT 10").all(server.id);
    for (const r of rows) db.prepare("UPDATE commands SET sent_at = ? WHERE id = ?").run(now(), r.id);
    return { ok: true, commands: rows.map((r) => ({ id: Number(r.id), cmd: r.cmd })) };
  }

  function view(server, { forPublic }) {
    const snap = server.snap ? JSON.parse(server.snap) : null;
    const fresh = snap && now() - server.snap_at < staleMs;
    const out = { id: server.id, name: server.name, online: Boolean(fresh), updatedAt: server.snap_at ?? null };
    if (fresh) Object.assign(out, { version: snap.version, players: { online: snap.online, max: snap.max }, tps: snap.tps, motd: snap.motd });
    if (fresh && (!forPublic || server.show_names)) out.names = snap.players.map((p) => p.name);
    return out;
  }

  const authAdmin = (req) => { const a = Buffer.from(sha(String(req.headers.authorization ?? "").replace(/^Bearer /, ""))), b = Buffer.from(sha(adminToken)); return a.length === b.length && timingSafeEqual(a, b); };

  async function readJson(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > maxBody) throw new HubError("Body too large", 413); chunks.push(c); }
    if (!n) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HubError("Body must be JSON", 400); }
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj, extra = {}) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", ...extra }); res.end(JSON.stringify(obj)); };
    try {
      const url = new URL(req.url, "http://x");
      const p = url.pathname;
      if (req.method === "POST" && p === "/v1/ingest") {
        const srv = byKey(String(req.headers.authorization ?? "").replace(/^Bearer /, ""));
        if (!srv) return send(401, { error: "Bad key" });
        if (limited(srv.id)) return send(429, { error: "Slow down" }, { "retry-after": "30" });
        return send(200, ingest(srv, await readJson(req)));
      }
      let m;
      if (req.method === "GET" && (m = /^\/v1\/public\/([a-z0-9-]+)$/.exec(p))) {
        const srv = bySlug(m[1]);
        if (!srv || !srv.is_public) return send(404, { error: "Not found" });
        return send(200, view(srv, { forPublic: true }), { "access-control-allow-origin": "*", "cache-control": "public, max-age=10" });
      }
      if (p.startsWith("/v1/admin/")) {
        if (!authAdmin(req)) return send(401, { error: "Admin token required" });
        if (req.method === "POST" && p === "/v1/admin/servers") return send(201, createServer(await readJson(req)));
        if (req.method === "GET" && p === "/v1/admin/servers") return send(200, { servers: db.prepare("SELECT * FROM servers ORDER BY created_at").all().map((s) => view(s, { forPublic: false })) });
        if ((m = /^\/v1\/admin\/servers\/([a-z0-9-]+)$/.exec(p)) && req.method === "GET") { const s = bySlug(m[1]); return s ? send(200, view(s, { forPublic: false })) : send(404, { error: "No such server" }); }
        if ((m = /^\/v1\/admin\/servers\/([a-z0-9-]+)\/rotate$/.exec(p)) && req.method === "POST") return send(200, rotateKey(m[1]));
        if ((m = /^\/v1\/admin\/servers\/([a-z0-9-]+)\/commands$/.exec(p)) && req.method === "POST") { const b = await readJson(req); return send(202, queue(m[1], b.action, b)); }
      }
      send(404, { error: "Not found" });
    } catch (e) {
      if (e instanceof HubError) return send(e.status, { error: e.message });
      send(500, { error: "Server error" });
    }
  });
  return { server, createServer, rotateKey, queue, db, close: () => { server.closeAllConnections?.(); server.close(); db.close(); } };
}

export class HubError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }
