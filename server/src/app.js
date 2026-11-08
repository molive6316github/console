import Fastify from "fastify";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { updater as defaultUpdater } from "./updater.js";
import { createAutoUpdate } from "./autoupdate.js";
import { mcRoot } from "./mc/index.js";
import { audit, listServers } from "./db.js";
import { createServices } from "./services.js";
import { serverRoutes } from "./routes/servers.js";
import { adminRoutes } from "./routes/admin.js";
import { discoverRoutes } from "./routes/discover.js";
import { setupRoutes } from "./routes/setup.js";
import { terminalRoutes } from "./routes/terminal.js";
import { linuxRoutes } from "./routes/linux.js";
import { mcRoutes } from "./routes/mc.js";
import { inviteRoutes } from "./routes/invites.js";
import { statusRoutes } from "./routes/status.js";
import { systemRoutes } from "./routes/system.js";
import { dnsRoutes } from "./routes/dns.js";
import { claudeCodeRoutes } from "./routes/claudecode.js";
import { createClaudeCode } from "./claudecode.js";
import { siteRoutes } from "./routes/sites.js";
import { nsRoutes } from "./routes/ns.js";
import { createPluginHost, pluginRoutes } from "./cplugins.js";
import { createPluginBuilder } from "./pluginbuilder.js";
import { createNsConfig, createAuthority, createNameserverServer } from "./nameserver.js";
import { createSites } from "./sites.js";
import { run as runCmd } from "./drivers/exec.js";
import { createSystem, createLogRing } from "./system.js";
import { hasPerm, PERMS, PRESETS } from "./perms.js";
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
  canRestart = () => Boolean(process.env.INVOCATION_ID || process.env.CONSOLE_SUPERVISED === "1"),
  onRestart = () => process.exit(75),
  restartDelayMs = 800,
  system = null,
  dnsOptions = null,
  siteOptions = null,
  nsOptions = null,
  pluginOptions = null,
  claudeOptions = null,
  logRing = createLogRing(),
  autoUpdateEveryMs = 0, // index.js turns this on; tests leave it off
  dataDir = process.env.CONSOLE_DATA || path.resolve(here, "../../data"),
  services = createServices({ db, dataDir }),
  // Safe mode switches off everything that turns a stolen admin session into code execution:
  // adding/editing servers, the file editor, and sending commands.
  safeMode = process.env.CONSOLE_SAFE_MODE === "1",
}) {
  const bootId = randomUUID(); // changes every start; the UI uses it to know the restart finished
  const app = Fastify({ logger, trustProxy: Boolean(process.env.CONSOLE_TRUST_PROXY) });
  app.register(cookie);
  // Keep the raw JSON text too: some plugins (Discord) must verify a signature over the exact bytes.
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 1_048_576 }, (req, body, done) => {
    req.rawBody = body;
    if (!body) return done(null, undefined);
    try { done(null, JSON.parse(body)); } catch { const e = new Error("Invalid JSON"); e.statusCode = 400; done(e); }
  });
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
    if (!reply.getHeader("Content-Security-Policy")) reply.header(
      "Content-Security-Policy",
      `default-src 'self'; img-src 'self' data:; ${style}; script-src 'self'; ${connect}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`
    );
    if (secureCookies) reply.header("Strict-Transport-Security", "max-age=31536000");
    if (req.url.startsWith("/api/")) reply.header("Cache-Control", "no-store");
  });

  // Websites made on the Website page are served by Host name, before anything else can see the request.
  let pluginHostRef = null;
  const sites = createSites({
    db, dataDir, run: runCmd, port: parseInt(process.env.PORT ?? "3000", 10),
    caddy: { sitesDir: process.env.CONSOLE_CADDY_SITES || "/etc/caddy/sites", caddyfile: process.env.CONSOLE_CADDYFILE || "/etc/caddy/Caddyfile" },
    pluginCss: () => pluginHostRef?.css() ?? "",
    publicStatus: async () => (await app.inject({ method: "GET", url: "/api/public/status", headers: { host: "localhost" } })).json(),
    ...(siteOptions ?? {}),
  });
  app.addHook("onRequest", async (req, reply) => {
    if (await sites.serve(req, reply)) return reply;
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

  // Permission check (owners always pass). People you invite carry a list of permissions; old accounts use their role's defaults.
  const allow = (perm) => async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: "Not logged in" });
    if (!hasPerm(req.user, perm)) return reply.code(403).send({ error: "You don't have permission to do that" });
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
    perms: req.user.perms,
    safeMode,
    mode: process.env.CONSOLE_MODE === "minecraft" ? "minecraft" : "standard",
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

  // ---- nightly auto-update (admin settings; the timer only runs when index.js asks for it) ----
  const autoUpdate = createAutoUpdate({
    db,
    updater,
    notifier: services.notifier,
    playersOnline: async () => {
      for (const sv of listServers(db)) {
        if (!mcRoot(sv)) continue;
        const st = await services.mc.liveStatus(sv).catch(() => null);
        if (st?.online && st.players?.online > 0) return true;
      }
      return false;
    },
    restart: () => canRestart() && setTimeout(onRestart, restartDelayMs),
  });
  app.get("/api/update/auto", { preHandler: need("admin") }, async () => ({ ...autoUpdate.get(), last: autoUpdate.lastRun(), channel: updater.channel ?? "release" }));
  app.put("/api/update/auto", { preHandler: need("admin") }, async (req, reply) => {
    try {
      const next = autoUpdate.set(req.body ?? {});
      audit(db, { username: req.user.username, action: "auto_update_setting", ok: true, detail: next.enabled ? `on, ${String(next.hour).padStart(2, "0")}:00` : "off" });
      return next;
    } catch (e) {
      return reply.code(400).send({ error: e.message });
    }
  });
  app.decorate("autoUpdate", autoUpdate);
  if (autoUpdateEveryMs > 0) {
    const t = setInterval(() => autoUpdate.tick().catch(() => {}), autoUpdateEveryMs);
    t.unref?.();
    app.addHook("onClose", async () => clearInterval(t));
  }

  // ---- servers, schedules, users, settings, host, audit ---------------------
  const ctx = { app, db, need, allow, runtime: services.runtime, notifier: services.notifier, scheduler: services.scheduler, terminal: services.terminal, safeMode };
  serverRoutes(app, ctx);
  adminRoutes(app, ctx);
  discoverRoutes(app, { ...ctx, discover: services.discover });
  setupRoutes(app, { ...ctx, setups: services.setups, jobs: services.jobs });
  terminalRoutes(app, { ...ctx, terminal: services.terminal });
  mcRoutes(app, { ...ctx, mc: services.mc });
  statusRoutes(app, { ...ctx, mc: services.mc, startup: services.startup, stats: services.stats, setups: services.setups, jobs: services.jobs, golive: services.golive, diagnose: services.diagnose, offsite: services.offsite });
  const playersOnline = async () => {
    for (const sv of listServers(db)) {
      if (!mcRoot(sv)) continue;
      const st = await services.mc.liveStatus(sv).catch(() => null);
      if (st?.online && st.players?.online > 0) return true;
    }
    return false;
  };
  systemRoutes(app, { ...ctx, system: system ?? createSystem({ jobs: services.jobs }), logs: logRing, jobs: services.jobs, onlinePlayers: playersOnline });
  // Console as its own nameserver (off until turned on). Hosts come from the panel domain, the join address and websites.
  let nsRef = null;
  const nsConfig = createNsConfig({
    db,
    publicIp: () => process.env.CONSOLE_PUBLIC_IP || "",
    knownHosts: () => {
      const out = [];
      const add = (name, srvPort) => { if (name && !out.some((h) => h.name === name.toLowerCase())) out.push({ name: name.toLowerCase(), srvPort }); };
      add(process.env.CONSOLE_DOMAIN);
      const join = getSetting(db, "join_domain", "");
      add(join, nsRef?.portOfHost(join));
      try { for (const s of JSON.parse(getSetting(db, "sites", "[]"))) add(s.host); } catch { /* none */ }
      return out;
    },
    ...(nsOptions?.config ?? {}),
  });
  const nsServer = createNameserverServer({ authority: createAuthority({ getConfig: () => nsConfig.get() }), port: parseInt(process.env.CONSOLE_NS_PORT ?? "53", 10), ...(nsOptions?.server ?? {}) });
  const ns = nsRoutes(app, { ...ctx, mc: services.mc, nsConfig, nsServer, run: runCmd, publicIp: () => process.env.CONSOLE_PUBLIC_IP, ...(nsOptions?.routes ?? {}) });
  app.addHook("onClose", async () => { await nsServer.stop(); });
  nsRef = ns;
  // Console plugins (built-in ones live in server/plugins, yours in <data>/plugins).
  const pluginHost = createPluginHost({ db, dataDir, services, builtinDir: path.resolve(here, "../plugins"), ...(pluginOptions ?? {}) });
  pluginHostRef = pluginHost;
  app.decorate("pluginHost", pluginHost);
  const builder = createPluginBuilder({ dataDir, jobs: services.jobs, claude: pluginOptions?.claude ?? createClaudeCode({ db, jobs: services.jobs, run: runCmd, ...(claudeOptions ?? {}) }), host: pluginHost, repoRoot: path.resolve(here, "../.."), ...(pluginOptions?.builder ?? {}) });
  pluginRoutes(app, { ...ctx, host: pluginHost, builder });
  if (pluginOptions?.boot !== false) app.addHook("onReady", async () => { await pluginHost.boot(); });
  app.addHook("onClose", async () => { pluginHost.shutdown(); });
  siteRoutes(app, { ...ctx, sites });
  const claude = createClaudeCode({ db, jobs: services.jobs, run: runCmd, ...(claudeOptions ?? {}) });
  claudeCodeRoutes(app, { ...ctx, claude });
  dnsRoutes(app, { ...ctx, mc: services.mc, publicIp: () => process.env.CONSOLE_PUBLIC_IP, ...(dnsOptions ?? {}) });
  inviteRoutes(app, { ...ctx, cookie: { name: COOKIE, secure: secureCookies } });
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
