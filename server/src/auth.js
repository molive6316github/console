import { parsePerms } from "./perms.js";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

export const ROLES = ["viewer", "operator", "admin"];
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyPassword(password, stored) {
  const [saltHex, hashHex] = String(stored).split(":");
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

export function createSession(db, userId) {
  const token = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(
    sha(token),
    userId,
    Date.now() + SESSION_MS
  );
  return { token, maxAgeSec: SESSION_MS / 1000 };
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.username, u.role, u.all_servers, u.perms, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`
    )
    .get(sha(token));
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
    return null;
  }
  return { id: row.id, username: row.username, role: row.role, allServers: row.all_servers === 1, perms: parsePerms(row.perms, row.role) };
}

// Sets a new password and signs out every session of that user except keepToken (the one making the change).
export function changePassword(db, userId, newPassword, keepToken) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha(keepToken ?? ""));
}

export function destroySession(db, token) {
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha(token));
}

export function hasRole(user, minRole) {
  return user && ROLES.indexOf(user.role) >= ROLES.indexOf(minRole);
}

// First run: make an admin so you are never locked out.
export function ensureAdmin(db, env = process.env) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  if (count > 0) return null;
  const username = env.CONSOLE_ADMIN_USER || "admin";
  const generated = !env.CONSOLE_ADMIN_PASSWORD;
  const password = env.CONSOLE_ADMIN_PASSWORD || randomBytes(9).toString("base64url");
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')").run(
    username,
    hashPassword(password)
  );
  return { username, password, generated };
}

// Crude in-memory login throttle: 8 failures per 10 minutes per IP.
const failures = new Map();
export function loginThrottled(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 10 * 60_000);
  failures.set(ip, recent);
  return recent.length >= 8;
}
export function recordLoginFailure(ip) {
  failures.set(ip, [...(failures.get(ip) ?? []), Date.now()]);
}
export function clearLoginFailures(ip) {
  failures.delete(ip);
}

// Ends every session of a user (used when an admin changes their role, scope or password).
export function destroyUserSessions(db, userId) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
