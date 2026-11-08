import { hashPassword, ROLES } from "./auth.js";
import { getServer } from "./db.js";
import { parsePerms, validatePerms, PRESETS } from "./perms.js";

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;
export const MIN_PASSWORD = 10;

export function listUsers(db) {
  const grants = db.prepare("SELECT user_id, server_id FROM user_servers").all();
  return db
    .prepare("SELECT id, username, role, all_servers, perms, created_at FROM users ORDER BY username COLLATE NOCASE")
    .all()
    .map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      allServers: u.all_servers === 1,
      perms: parsePerms(u.perms, u.role),
      servers: grants.filter((g) => g.user_id === u.id).map((g) => g.server_id),
      created: u.created_at,
    }));
}

function checkScope(db, body) {
  const allServers = body.allServers !== false;
  const servers = Array.isArray(body.servers) ? [...new Set(body.servers)] : [];
  if (!allServers) {
    if (!servers.length) throw new UserError("Pick at least one server, or allow all servers");
    for (const id of servers) if (typeof id !== "string" || !getServer(db, id)) throw new UserError(`No such server: ${String(id).slice(0, 40)}`);
  }
  return { allServers, servers: allServers ? [] : servers };
}

function setGrants(db, userId, servers) {
  db.prepare("DELETE FROM user_servers WHERE user_id = ?").run(userId);
  const ins = db.prepare("INSERT INTO user_servers (user_id, server_id) VALUES (?, ?)");
  for (const s of servers) ins.run(userId, s);
}

export function createUser(db, body) {
  const { username, password, role } = body ?? {};
  if (typeof username !== "string" || !NAME.test(username)) throw new UserError("Username: 2-32 letters, numbers, dots, dashes or underscores");
  if (typeof password !== "string" || password.length < MIN_PASSWORD) throw new UserError(`Password must be at least ${MIN_PASSWORD} characters`);
  if (password.length > 200) throw new UserError("Password is too long");
  if (!ROLES.includes(role)) throw new UserError("Role must be viewer, operator or admin");
  const scope = role === "admin" ? { allServers: true, servers: [] } : checkScope(db, body);
  if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) throw new UserError("That username is taken", 409);
  const r = db
    .prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, ?)")
    .run(username, hashPassword(password), role, scope.allServers ? 1 : 0);
  const id = Number(r.lastInsertRowid);
  setGrants(db, id, scope.servers);
  return id;
}

const adminCount = (db) => db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;

// Returns true when the user's sessions should be ended (role, scope or password changed).
export function updateUser(db, id, body, actorId) {
  const u = db.prepare("SELECT id, username, role FROM users WHERE id = ?").get(id);
  if (!u) throw new UserError("No such user", 404);
  const b = body ?? {};
  const role = b.role ?? u.role;
  if (!ROLES.includes(role)) throw new UserError("Role must be viewer, operator or admin");
  if (u.role === "admin" && role !== "admin" && adminCount(db) <= 1) throw new UserError("That's the last admin. Make someone else admin first.");
  if (u.id === actorId && role !== u.role) throw new UserError("You can't change your own role");
  const scope = role === "admin" ? { allServers: true, servers: [] } : checkScope(db, b);
  if (b.password !== undefined) {
    if (typeof b.password !== "string" || b.password.length < MIN_PASSWORD) throw new UserError(`Password must be at least ${MIN_PASSWORD} characters`);
    if (b.password.length > 200) throw new UserError("Password is too long");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(b.password), id);
  }
  if (b.perms !== undefined || b.preset !== undefined) {
    if (role === "admin") throw new UserError("Owners always have every permission");
    let list = null;
    if (b.preset) { if (!PRESETS[b.preset]) throw new UserError("Unknown role"); list = PRESETS[b.preset].perms; }
    else if (b.perms !== null) { list = validatePerms(b.perms); if (!list) throw new UserError("Those permissions aren't valid"); }
    db.prepare("UPDATE users SET perms = ? WHERE id = ?").run(list ? JSON.stringify(list) : null, id);
  }
  db.prepare("UPDATE users SET role = ?, all_servers = ? WHERE id = ?").run(role, scope.allServers ? 1 : 0, id);
  setGrants(db, id, scope.servers);
  return true;
}

export function deleteUser(db, id, actorId) {
  const u = db.prepare("SELECT id, role FROM users WHERE id = ?").get(id);
  if (!u) throw new UserError("No such user", 404);
  if (u.id === actorId) throw new UserError("You can't delete yourself");
  if (u.role === "admin" && adminCount(db) <= 1) throw new UserError("That's the last admin");
  db.prepare("DELETE FROM users WHERE id = ?").run(id);
}
