import { randomBytes, createHash } from "node:crypto";
import { createUser, UserError } from "./users.js";
import { PRESETS, validatePerms } from "./perms.js";
import { getServer } from "./db.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const DAY = 86_400_000;
const MAX_OPEN = 50;

export function createInvites(db, now = () => Date.now()) {
  function create({ serverId, preset, perms, note, days, actor }) {
    if (!getServer(db, serverId)) throw new UserError("No such server", 404);
    let list;
    if (preset !== undefined && preset !== null && preset !== "") {
      if (!PRESETS[preset]) throw new UserError("Unknown role");
      list = PRESETS[preset].perms;
    } else {
      list = validatePerms(perms);
      if (!list) throw new UserError("Those permissions aren't valid");
      if (!list.length) throw new UserError("Pick at least one thing they can do");
    }
    const d = days === undefined ? 3 : Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 14) throw new UserError("Expiry must be 1 to 14 days");
    const n = typeof note === "string" ? note.trim().slice(0, 80) : "";
    const open = db.prepare("SELECT COUNT(*) AS n FROM invites WHERE used_at IS NULL AND expires_at > ?").get(now()).n;
    if (open >= MAX_OPEN) throw new UserError("Too many open invites. Remove some first.");
    const token = randomBytes(24).toString("base64url");
    const r = db.prepare("INSERT INTO invites (token_hash, server_id, preset, perms, note, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(sha(token), serverId, preset || null, JSON.stringify(list), n || null, actor, now(), now() + d * DAY);
    return { id: Number(r.lastInsertRowid), token, expiresAt: now() + d * DAY };
  }

  function list(serverId) {
    return db.prepare("SELECT id, server_id, preset, perms, note, created_by, created_at, expires_at, used_at, used_by FROM invites WHERE server_id = ? ORDER BY id DESC LIMIT 100").all(serverId)
      .map((r) => ({ id: r.id, serverId: r.server_id, preset: r.preset, perms: JSON.parse(r.perms), note: r.note, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, usedBy: r.used_by, state: r.used_at ? "used" : r.expires_at <= now() ? "expired" : "open" }));
  }

  const revoke = (id) => db.prepare("DELETE FROM invites WHERE id = ? AND used_at IS NULL").run(id).changes > 0;

  function find(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100) return null;
    const row = db.prepare("SELECT * FROM invites WHERE token_hash = ?").get(sha(token));
    if (!row || row.used_at || row.expires_at <= now()) return null;
    return row;
  }

  function peek(token) {
    const row = find(token);
    if (!row) return null;
    const server = getServer(db, row.server_id);
    if (!server) return null;
    return { serverName: server.name, perms: JSON.parse(row.perms), preset: row.preset, expiresAt: row.expires_at };
  }

  // Creates the account and burns the invite in one step, so a link can only ever be used once.
  function accept(token, { username, password }) {
    const row = find(token);
    if (!row) throw new UserError("This invite link isn't valid or has expired", 404);
    if (!getServer(db, row.server_id)) throw new UserError("This invite link isn't valid or has expired", 404);
    db.exec("BEGIN IMMEDIATE");
    try {
      const fresh = db.prepare("SELECT used_at FROM invites WHERE id = ?").get(row.id);
      if (fresh.used_at) throw new UserError("This invite link isn't valid or has expired", 404);
      const id = createUser(db, { username, password, role: "viewer", allServers: false, servers: [row.server_id] });
      db.prepare("UPDATE users SET perms = ? WHERE id = ?").run(row.perms, id);
      db.prepare("UPDATE invites SET used_at = ?, used_by = ? WHERE id = ?").run(now(), username, row.id);
      db.exec("COMMIT");
      return { userId: id, username, serverId: row.server_id };
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }

  return { create, list, revoke, peek, accept };
}
