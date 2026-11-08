import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { updater as defaultUpdater } from "./updater.js";
import { audit } from "./db.js";
import { createServices } from "./services.js";
import { serverRoutes } from "./routes/servers.js";
import { adminRoutes } from "./routes/admin.js";
import { discoverRoutes } from "./routes/discover.js";
import { setupRoutes } from "./routes/setup.js";
import { terminalRoutes } from "./routes/terminal.js";
import { linuxRoutes } from "./routes/linux.js";
import { getSetting } from "./db.js";
import {
  verifyPassword,
  createSession,
  userFromToken,
  destroySession,
  hasRole,
  loginThrottled,
  recordLoginFailure,
  clearLoginFailures,
  changePassword,
} from "./auth.js";

const COOKIE = "console_session";
const DUMMY_HASH = "00:" + "00".repeat(64);
const MIN_PASSWORD = 10;
const here = path.dirname(fileURLToPath(import.meta.url));

export function buildApp({
  db,
  secureCookies = false,
  logger = false,
  version = "dev",
  updater = defaultUpdater,
  // After an update the process exits with a non-zero code so systemd (Restart=on-failure) brings it back.
  // Outside systemd there is nothing to bring it back, so we only exit when INVOCATION_ID is set.
  canRestart = () => Boolean(process.env.INVOCATION_ID),
  onRestart = () => process.exit(75),
  restartDelayMs = 800,
  dataDir = process.env.CONSOLE_DATA || path.resolve(here, "../../data"),
  services = createServices({ db, dataDir }),
  // Safe mode switches off everything that turns a stolen admin session into code execution:
  // adding/editing servers, the file editor, and sending commands.
  safeMode = process.env.CONSOLE_SAFE_MODE === "1",
}) {
  const bootId = randomUUID(); // changes every start; the UI uses it to know the restart finished
  const app = Fastify({ logger, trustProxy: Boolean(process.env.CONSOLE_TRUST_PROXY) });
  app.register(cookie);
  app.decorate("services", services);

  // Errors with a status (bad input, conflicts, not found) become clean JSON. Anything else is a 500 that doesn't leak details.
  app.setErrorHandler((err, req, reply) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    reply.code(status).send({ error: status >= 500 && !err.status ? "Something went wrong on the server" : err.message });
  });

  // ---- security headers ----------------------------------------------------
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    // The terminal page is separate because xterm.js sets inline styles; the main app keeps the strict policy.
    const termPage = req.url.split("?")[0] === "/terminal.html";
    const style = termPage ? "style-src 'self' 'unsafe-inline'" : "style-src 'self'";
    const host = String(req.headers.host ?? "").replace(/[^A-Za-z0-9.:\[\]-]/g, "");
    const connect = termPage && host ? `connect-src 'self' ws://${host} wss://${host}` : "connect-src 'self'";
    reply.header(
      "Content-Security-Policy",
      `default-src 'self'; img-src 'self' data:; ${style}; script-src 'self'; ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    );
    if (secureCookies) reply.header("Strict-Transport-Security", "max-age=31536000");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  // ---- auth plumbing -------------------------------------------------------
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (req) => {
    req.user = userFromToken(db, req.cookies?.[COOKIE]);
  });

  // POST requests must be JSON: blocks plain cross-site form posts. Cookie is SameSite=Strict too.
  app.addHook("preHandler", async (req, reply) => {
    if ((req.method === "POST" || req.method === "PUT") && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      return reply.code(415).send({ error: "Content-Type must be application/json" });
    }
  });

  const need = (minRole) => async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "Not logged in" });
    if (!hasRole(req.user, minRole)) return reply.code(403).send({ error: `Requires role: ${minRole}` });
  };

  // ---- routes --------------------------------------------------------------
  app.post("/api/login", async (req, reply) => {
    const ip = req.ip;
    if (loginThrottled(ip)) return reply.code(429).send({ error: "Too many attempts, try again later" });
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || typeof password !== "string") {
      return reply.code(400).send({ error: "username and password required" });
    }
    const row = db.prepare("SELECT id, username, password_hash, role FROM users WHERE username = ?").get(username);
    // Always run a hash comparison so timing doesn't reveal whether the user exists.
    let ok = false;
    if (row) ok = verifyPassword(password, row.password_hash);
    else verifyPassword(password, DUMMY_HASH); // burn the same time, result ignored
    if (!ok) {
      recordLoginFailure(ip);
      audit(db, { username: username.slice(0, 64), action: "login", ok: false });
      return reply.code(401).send({ error: "Wrong username or password" });
    }
    clearLoginFailures(ip);
    const { token, maxAgeSec } = createSession(db, row.id);
    reply.setCookie(COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: secureCookies,
      path: "/",
      maxAge: maxAgeSec,
    });
    audit(db, { username: row.username, action: "login", ok: true });
    return { username: row.username, role: row.role };
  });

  app.post("/api/logout", async (req, reply) => {
    destroySession(db, req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/api/me", { preHandler: need("viewer") }, async (req) => ({
    username: req.user.username,
    role: req.user.role,
    allServers: req.user.allServers,
    safeMode,
    version,
    bootId,
    // Opt-in advanced tools: only admins are told they exist, and only when switched on.
    features: req.user.role === "admin" && !safeMode ? { terminal: services.terminal.enabled(), linuxUsers: getSetting(db, "linux_users_enabled", "0") === "1" } : { terminal: false, linuxUsers: false },
  }));

  // Any signed-in user can change their own password.
  app.post("/api/password", { preHandler: need("viewer") }, async (req, reply) => {
    const ip = req.ip;
    if (loginThrottled(ip)) return reply.code(429).send({ error: "Too many attempts, try again later" });
    const { current, next } = req.body ?? {};
    if (typeof current !== "string" || typeof next !== "string") {
      return reply.code(400).send({ error: "current and next password required" });
    }
    if (next.length < MIN_PASSWORD) {
      return reply.code(400).send({ error: `New password must be at least ${MIN_PASSWORD} characters` });
    }
    if (next.length > 200) return reply.code(400).send({ error: "New password is too long" });

    const row = db.prepare("SELECT password_hash FROM users WHERE id = ?").get(req.user.id);
    // 403, not 401: the UI treats 401 as "session expired" and would sign you out.
    if (!row || !verifyPassword(current, row.password_hash)) {
      recordLoginFailure(ip);
      audit(db, { username: req.user.username, action: "password_change", ok: false, detail: "wrong current password" });
      return reply.code(403).send({ error: "Current password is wrong" });
    }
    if (next === current) return reply.code(400).send({ error: "New password must be different" });

    changePassword(db, req.user.id, next, req.cookies?.[COOKIE]);
    audit(db, { username: req.user.username, action: "password_change", ok: true });
    return { ok: true };
  });

  // ---- self-update (admin only) -------------------------------------------
  app.get("/api/update", { preHandler: need("admin") }, async (req) =>
    updater.check({ force: req.query?.force === "1" })
  );

  app.post("/api/update", { preHandler: need("admin") }, async (req, reply) => {
    const result = await updater.apply();
    audit(db, {
      username: req.user.username,
      action: "update",
      ok: result.ok,
      detail: result.ok ? (result.updated ? `${result.from} -> ${result.to}` : "already up to date") : result.error,
    });
    if (!result.ok) return reply.code(500).send(result);
    const restarting = Boolean(result.updated) && canRestart();
    if (restarting) setTimeout(onRestart, restartDelayMs); // let this response reach the browser first
    return { ...result, restarting };
  });

  // ---- servers, schedules, users, settings, host, audit ---------------------
  const ctx = { app, db, need, runtime: services.runtime, notifier: services.notifier, scheduler: services.scheduler, terminal: services.terminal, safeMode };
  serverRoutes(app, ctx);
  adminRoutes(app, ctx);
  discoverRoutes(app, { ...ctx, discover: services.discover });
  setupRoutes(app, { ...ctx, setups: services.setups, jobs: services.jobs });
  terminalRoutes(app, { ...ctx, terminal: services.terminal });
  linuxRoutes(app, { ...ctx, linux: services.linux, featureOn: () => getSetting(db, "linux_users_enabled", "0") === "1" });

  // Restart Console (admin). Under systemd it comes straight back; elsewhere it just says so.
  app.post("/api/restart", { preHandler: need("admin") }, async (req) => {
    audit(db, { username: req.user.username, action: "restart", ok: true });
    const restarting = canRestart();
    if (restarting) setTimeout(onRestart, restartDelayMs);
    return { restarting };
  });

  // ---- built frontend (after `npm run build`) -----------------------------
  const dist = path.resolve(here, "../../web/dist");
  if (existsSync(dist)) {
    app.register(fastifyStatic, { root: dist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
