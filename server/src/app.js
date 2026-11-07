import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDriver } from "./drivers/index.js";
import { getServer, listServers, audit } from "./db.js";
import {
  verifyPassword,
  createSession,
  userFromToken,
  destroySession,
  hasRole,
  loginThrottled,
  recordLoginFailure,
  clearLoginFailures,
} from "./auth.js";

const COOKIE = "console_session";
const DUMMY_HASH = "00:" + "00".repeat(64);
const ACTIONS = ["start", "stop", "restart"];
const here = path.dirname(fileURLToPath(import.meta.url));

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

export function buildApp({ db, secureCookies = false, logger = false }) {
  const app = Fastify({ logger, trustProxy: Boolean(process.env.CONSOLE_TRUST_PROXY) });
  app.register(cookie);

  const busy = new Set(); // server ids with an action in flight

  // ---- security headers ----------------------------------------------------
  app.addHook("onSend", async (req, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
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
    if (req.method === "POST" && !String(req.headers["content-type"] ?? "").startsWith("application/json")) {
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
  }));

  app.get("/api/servers", { preHandler: need("viewer") }, async (req) => {
    const servers = listServers(db);
    const canAct = hasRole(req.user, "operator");
    return Promise.all(
      servers.map(async (s) => {
        let status = "unknown";
        let error = null;
        let readOnly = false;
        try {
          const driver = getDriver(s.type);
          readOnly = Boolean(driver.readOnly);
          status = await withTimeout(driver.status(s.target, { id: s.id }), 6000, "status check");
        } catch (e) {
          error = e.message;
        }
        // The target (hosts, commands, paths) stays server-side: it is not sent to the browser.
        return {
          id: s.id,
          name: s.name,
          type: s.type,
          status,
          error,
          busy: busy.has(s.id),
          canAct: canAct && !readOnly,
        };
      })
    );
  });

  app.post("/api/servers/:id/:action", { preHandler: need("operator") }, async (req, reply) => {
    const { id, action } = req.params;
    if (!ACTIONS.includes(action)) return reply.code(400).send({ error: "Unknown action" });
    const server = getServer(db, id);
    if (!server) return reply.code(404).send({ error: "No such server" });
    if (busy.has(id)) return reply.code(409).send({ error: "Another action is already running on this server" });

    const driver = getDriver(server.type);
    if (driver.readOnly) return reply.code(400).send({ error: "This server is read-only" });

    busy.add(id);
    try {
      await withTimeout(driver[action](server.target, { id }), 120_000, action);
      audit(db, { username: req.user.username, serverId: id, action, ok: true });
      const status = await withTimeout(driver.status(server.target, { id }), 6000, "status check").catch(
        () => "unknown"
      );
      return { ok: true, status };
    } catch (e) {
      audit(db, { username: req.user.username, serverId: id, action, ok: false, detail: e.message });
      return reply.code(500).send({ error: e.message });
    } finally {
      busy.delete(id);
    }
  });

  app.get("/api/audit", { preHandler: need("admin") }, async () =>
    db.prepare("SELECT id, ts, username, server_id, action, ok, detail FROM audit_log ORDER BY id DESC LIMIT 100").all()
  );

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
