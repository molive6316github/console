import { listServers, getServer } from "./db.js";

// Admins and "all servers" users see everything. Scoped users see only servers they were granted.
export function canSee(db, user, serverId) {
  if (!user) return false;
  if (user.role === "admin" || user.allServers) return true;
  return Boolean(db.prepare("SELECT 1 FROM user_servers WHERE user_id = ? AND server_id = ?").get(user.id, serverId));
}

export function visibleServers(db, user) {
  const all = listServers(db);
  if (user.role === "admin" || user.allServers) return all;
  const ids = new Set(db.prepare("SELECT server_id FROM user_servers WHERE user_id = ?").all(user.id).map((r) => r.server_id));
  return all.filter((s) => ids.has(s.id));
}

// A server the user may not see looks exactly like one that doesn't exist.
export function serverFor(db, user, id) {
  const s = getServer(db, id);
  return s && canSee(db, user, id) ? s : null;
}
