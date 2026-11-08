import path from "node:path";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { getSetting, setSetting, audit, listServers } from "./db.js";
import { mcRoot } from "./mc/index.js";

export class PluginError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
const TYPES = new Set(["text", "secret", "number", "bool", "select", "color", "textarea"]);
const MAX_CSS = 40_000;
const MAX_STORE = 200_000;

export function readManifest(dir, builtin) {
  const file = path.join(dir, "manifest.json");
  if (!existsSync(file)) return null;
  let m;
  try { m = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return { error: `manifest.json isn't valid JSON (${e.message})`, id: path.basename(dir), name: path.basename(dir), dir, builtin }; }
  const id = String(m.id ?? path.basename(dir));
  if (!ID.test(id)) return { error: `Bad plugin id "${id}" (use a-z, 0-9 and dashes)`, id: path.basename(dir), name: id, dir, builtin };
  const settings = (Array.isArray(m.settings) ? m.settings : []).filter((s) => s && /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(s.key) && TYPES.has(s.type));
  const actions = (Array.isArray(m.actions) ? m.actions : []).filter((a) => a && typeof a.label === "string" && /^\/[A-Za-z0-9_\-/]{1,60}$/.test(a.path ?? "")).map((a) => ({ label: a.label.slice(0, 40), path: a.path })).slice(0, 6);
  return { id, actions, name: String(m.name ?? id).slice(0, 60), version: String(m.version ?? "0.0.0").slice(0, 20), description: String(m.description ?? "").slice(0, 300), author: String(m.author ?? "").slice(0, 60), permissions: (Array.isArray(m.permissions) ? m.permissions : []).map(String).slice(0, 12), settings, entry: String(m.entry ?? "index.js"), defaultEnabled: m.defaultEnabled === true, dir, builtin: Boolean(builtin) };
}

export function createPluginHost({ db, dataDir, services, builtinDir, userDir = path.join(dataDir, "plugins"), pollMs = 15_000, log = (...a) => console.log("[plugin]", ...a) }) {
  const state = new Map(); // id -> { status, error, stops, routes, css, listeners, timers }
  let timer = null;
  let live = { up: null, names: new Set() };

  const enabledMap = () => { try { return JSON.parse(getSetting(db, "cplugins", "{}")); } catch { return {}; } };
  const setEnabled = (id, on) => setSetting(db, "cplugins", JSON.stringify({ ...enabledMap(), [id]: on }));

  function discover() {
    const out = new Map();
    for (const [dir, builtin] of [[builtinDir, true], [userDir, false]]) {
      if (!dir || !existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        const d = path.join(dir, n);
        try { if (!statSync(d).isDirectory()) continue; } catch { continue; }
        const m = readManifest(d, builtin);
        if (m && !(out.has(m.id) && out.get(m.id).builtin)) out.set(m.id, m); // built-ins can't be shadowed by a folder with the same id
      }
    }
    return out;
  }

  const settingsKey = (id) => `cpset.${id}`;
  function settingsOf(m) {
    let saved = {};
    try { saved = JSON.parse(getSetting(db, settingsKey(m.id), "{}")); } catch { /* none */ }
    const out = {};
    for (const s of m.settings) out[s.key] = saved[s.key] !== undefined ? saved[s.key] : s.default ?? (s.type === "bool" ? false : s.type === "number" ? 0 : "");
    return out;
  }
  function saveSettings(m, patch) {
    const cur = settingsOf(m);
    for (const s of m.settings) {
      if (patch[s.key] === undefined) continue;
      let v = patch[s.key];
      if (s.type === "secret" && (v === "" || v === null)) continue; // blank keeps the saved secret
      if (s.type === "bool") v = v === true;
      else if (s.type === "number") { v = Number(v); if (!Number.isFinite(v)) throw new PluginError(`${s.label ?? s.key} must be a number`); if (s.min !== undefined && v < s.min) throw new PluginError(`${s.label ?? s.key} must be at least ${s.min}`); if (s.max !== undefined && v > s.max) throw new PluginError(`${s.label ?? s.key} must be at most ${s.max}`); }
      else if (s.type === "select") { v = String(v); if (!(s.options ?? []).map((o) => String(o.value ?? o)).includes(v)) throw new PluginError(`${s.label ?? s.key}: pick one of the listed options`); }
      else if (s.type === "color") { v = String(v); if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw new PluginError(`${s.label ?? s.key} must look like #4ade80`); }
      else { v = String(v); if (v.length > (s.type === "textarea" ? 4000 : 500)) throw new PluginError(`${s.label ?? s.key} is too long`); }
      cur[s.key] = v;
    }
    setSetting(db, settingsKey(m.id), JSON.stringify(cur));
    return cur;
  }
  function viewSettings(m) {
    const cur = settingsOf(m);
    return m.settings.map((s) => ({ ...s, value: s.type === "secret" ? "" : cur[s.key], hasValue: s.type === "secret" ? Boolean(cur[s.key]) : undefined }));
  }

  // ---- what a plugin is handed ----
  function makeCtx(m, st) {
    const emitters = st.listeners;
    const mcServers = () => listServers(db).filter((s) => mcRoot(s));
    const pick = (id) => (id ? mcServers().find((s) => s.id === id) : mcServers()[0]) ?? null;
    return {
      id: m.id,
      dir: m.dir,
      log: (...a) => log(`${m.id}:`, ...a),
      settings: { get: () => settingsOf(m), set: (patch) => saveSettings(m, patch) },
      store: {
        get: (k, d = null) => { try { const o = JSON.parse(getSetting(db, `cpstore.${m.id}`, "{}")); return o[k] ?? d; } catch { return d; } },
        set: (k, v) => {
          let o = {}; try { o = JSON.parse(getSetting(db, `cpstore.${m.id}`, "{}")); } catch { /* fresh */ }
          o[k] = v;
          const text = JSON.stringify(o);
          if (text.length > MAX_STORE) throw new PluginError("Plugin storage is full (200 KB)");
          setSetting(db, `cpstore.${m.id}`, text);
        },
      },
      mc: {
        servers: () => mcServers().map((s) => ({ id: s.id, name: s.name, root: mcRoot(s) })),
        live: async (id) => { const s = pick(id); return s ? services.mc.liveStatus(s) : null; },
        run: async (cmd, id) => { const s = pick(id); if (!s) throw new PluginError("No Minecraft server"); if (!/^[\x20-\x7e]{1,200}$/.test(String(cmd))) throw new PluginError("Bad command"); return services.runtime.perform(s, "command", `plugin:${m.id}`, String(cmd)); },
      },
      on: (event, fn) => { (emitters.get(event) ?? emitters.set(event, []).get(event)).push(fn); },
      every: (seconds, fn) => { const t = setInterval(() => { Promise.resolve().then(fn).catch((e) => log(`${m.id}: ${e.message}`)); }, Math.max(5, seconds) * 1000); t.unref?.(); st.timers.push(t); },
      route: (method, p, opts, handler) => {
        if (typeof opts === "function") { handler = opts; opts = {}; }
        if (!/^\/[A-Za-z0-9_\-/:.]*$/.test(p)) throw new PluginError(`Bad route path ${p}`);
        st.routes.push({ method: String(method).toUpperCase(), parts: p.split("/").filter(Boolean), access: opts?.public ? "public" : "admin", handler });
      },
      css: (text) => { const t = String(text); if (t.length > MAX_CSS) throw new PluginError("Plugin CSS is too big"); st.css.push(t); },
      notify: (text) => services.notifier.send(String(text).slice(0, 1800)),
      fetch: (...a) => fetch(...a),
      onStop: (fn) => st.stops.push(fn),
    };
  }

  async function start(m) {
    stop(m.id);
    const st = { status: "starting", error: null, stops: [], routes: [], css: [], listeners: new Map(), timers: [] };
    state.set(m.id, st);
    try {
      const entry = path.join(m.dir, m.entry);
      if (!entry.startsWith(m.dir + path.sep) || !existsSync(entry)) throw new Error(`${m.entry} not found`);
      const mod = await import(`${pathToFileURL(entry).href}?v=${Date.now()}`);
      const fn = mod.default ?? mod.activate;
      if (typeof fn !== "function") throw new Error("The plugin must export a default function");
      const r = await fn(makeCtx(m, st));
      if (r && typeof r.stop === "function") st.stops.push(r.stop);
      st.status = "running";
      log(`${m.id} started`);
    } catch (e) {
      st.status = "error";
      st.error = e.message;
      log(`${m.id} failed to start: ${e.message}`);
    }
    return st;
  }
  function stop(id) {
    const st = state.get(id);
    if (!st) return;
    for (const t of st.timers) clearInterval(t);
    for (const f of st.stops) { try { f(); } catch { /* ignore */ } }
    state.delete(id);
  }

  // ---- events from the game ----
  function emit(event, payload) {
    for (const [id, st] of state) for (const fn of st.listeners.get(event) ?? []) Promise.resolve().then(() => fn(payload)).catch((e) => log(`${id}: ${event} handler: ${e.message}`));
  }
  async function poll() {
    if (![...state.values()].some((s) => s.listeners.size)) return;
    const server = listServers(db).find((s) => mcRoot(s));
    if (!server) return;
    let st;
    try { st = await services.mc.liveStatus(server); } catch { return; }
    const up = Boolean(st.online);
    if (live.up !== null && up !== live.up) emit(up ? "server:up" : "server:down", { server: server.name });
    const names = new Set(up ? (st.players?.names ?? []) : []);
    if (live.up !== null) {
      for (const n of names) if (!live.names.has(n)) emit("player:join", { name: n, server: server.name, online: st.players?.online });
      for (const n of live.names) if (!names.has(n)) emit("player:leave", { name: n, server: server.name, online: st.players?.online });
    }
    live = { up, names };
    emit("tick", { up, players: st.players ?? null });
  }

  // ---- requests ----
  async function dispatch(id, access, method, subpath, req) {
    const st = state.get(id);
    if (!st || st.status !== "running") throw new PluginError("No such plugin route", 404);
    const parts = subpath.split("/").filter(Boolean);
    for (const r of st.routes) {
      if (r.access !== access || (r.method !== method && !(method === "HEAD" && r.method === "GET"))) continue;
      if (r.parts.length !== parts.length) continue;
      const params = {};
      if (!r.parts.every((p, i) => (p.startsWith(":") ? ((params[p.slice(1)] = decodeURIComponent(parts[i])), true) : p === parts[i]))) continue;
      return r.handler({ params, query: req.query ?? {}, body: req.body, headers: req.headers, method, ip: req.ip, raw: req.rawBody });
    }
    throw new PluginError("No such plugin route", 404);
  }

  const list = () => [...discover().values()].map((m) => {
    const st = state.get(m.id);
    return { id: m.id, name: m.name, version: m.version, description: m.description, author: m.author, permissions: m.permissions, actions: m.actions ?? [], builtin: m.builtin, error: m.error ?? null, enabled: Boolean(enabledMap()[m.id]), status: st?.status ?? "off", runError: st?.error ?? null, settings: m.error ? [] : viewSettings(m) };
  });

  async function configure(id, { enabled, settings } = {}) {
    const m = discover().get(id);
    if (!m || m.error) throw new PluginError("No such plugin", 404);
    if (settings) saveSettings(m, settings);
    if (enabled !== undefined) {
      setEnabled(id, enabled === true);
      if (enabled === true) await start(m); else stop(id);
    } else if (enabledMap()[id]) {
      await start(m); // settings changed: restart it so it picks them up
    }
    return list().find((p) => p.id === id);
  }

  async function boot() {
    const map = enabledMap();
    for (const m of discover().values()) {
      if (m.error) continue;
      if (map[m.id] === undefined && m.defaultEnabled) setEnabled(m.id, true);
      if (enabledMap()[m.id]) await start(m);
    }
    timer = setInterval(() => poll().catch(() => {}), pollMs);
    timer.unref?.();
  }
  function shutdown() { clearInterval(timer); for (const id of [...state.keys()]) stop(id); }

  const css = () => [...state.values()].flatMap((s) => s.css).join("\n");

  return { boot, shutdown, list, configure, dispatch, css, poll, emit, discover, userDir, state };
}

export function pluginRoutes(app, { db, need, host, safeMode, builder }) {
  const wrap = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) { if (e instanceof PluginError || e.status) return reply.code(e.status ?? 400).send({ error: e.message }); throw e; }
  };
  const noSafe = async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on: this is disabled" });

  app.get("/api/cplugins", { preHandler: need("admin") }, async () => ({ plugins: host.list(), folder: host.userDir }));
  app.put("/api/cplugins/:id", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const r = await host.configure(req.params.id, req.body ?? {});
    audit(db, { username: req.user.username, action: "plugin_config", ok: true, detail: `${req.params.id}${req.body?.enabled !== undefined ? ` ${req.body.enabled ? "on" : "off"}` : ""}` });
    return r;
  }));

  // ---- "describe it and Claude writes it" ----
  app.post("/api/cplugins/build", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const r = await builder.start(req.body?.prompt, req.user.username);
    audit(db, { username: req.user.username, action: "plugin_build", ok: true, detail: String(req.body?.prompt).slice(0, 120) });
    return r;
  }));
  app.get("/api/cplugins/drafts", { preHandler: need("admin") }, wrap(async () => ({ drafts: await builder.drafts() })));
  app.get("/api/cplugins/drafts/:id", { preHandler: need("admin") }, wrap(async (req) => ({ files: await builder.files(req.params.id) })));
  app.post("/api/cplugins/drafts/:id/install", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => {
    const r = await builder.install(req.params.id);
    audit(db, { username: req.user.username, action: "plugin_install_draft", ok: true, detail: r.id });
    return r;
  }));
  app.delete("/api/cplugins/drafts/:id", { preHandler: [need("admin"), noSafe] }, wrap(async (req) => { await builder.discard(req.params.id); return { ok: true }; }));

  // Styling plugins add CSS here; the panel and website templates load it.
  app.get("/api/plugins.css", async (_req, reply) => reply.header("Cache-Control", "no-store").type("text/css").send(host.css()));

  const send = async (reply, r) => {
    if (r && typeof r === "object" && ("body" in r || "status" in r || "headers" in r)) {
      for (const [k, v] of Object.entries(r.headers ?? {})) reply.header(k, v);
      if (r.type) reply.type(r.type);
      return reply.code(r.status ?? 200).send(r.body ?? "");
    }
    return reply.send(r ?? { ok: true });
  };
  // Public routes a plugin registers (like the JSON API) live under /x/<id>/..., admin-only ones under /api/x/<id>/...
  app.all("/x/:id/*", wrap(async (req, reply) => send(reply, await host.dispatch(req.params.id, "public", req.method, req.params["*"], req))));
  app.all("/api/x/:id/*", { preHandler: need("admin") }, wrap(async (req, reply) => send(reply, await host.dispatch(req.params.id, "admin", req.method, req.params["*"], req))));
}
