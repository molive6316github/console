import path from "node:path";
import { mkdir, writeFile, chmod } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { getSetting, setSetting } from "./db.js";
import { userById } from "./auth.js";
import { AGENTS } from "./autofix.js";
import { toolsBin } from "./claudecode.js";

export class AssistantError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

const sha = (s) => createHash("sha256").update(s).digest("hex");
const DEFAULTS = { enabled: false, agent: "claude", custom: "" };
const TOKEN_MS = 12 * 60_000;
const APPROVAL_MS = 6 * 60_000;

// Things an assistant call can never reach, however it's asked: managing people, sessions, the terminal, itself.
export const AGENT_BLOCKED = [/^\/api\/(users|invites|people|password|login|logout|terminal|claude-code|autofix)\b/, /^\/api\/assistant\/(message|turns|history)\b/, /^\/api\/assistant$/];
// These pause until the person clicks Approve in the chat.
export const NEEDS_APPROVAL = (method, p) => method === "DELETE" || /\/(restore|uninstall|wipe|reset|power|restart|stop|kill|nameserver|ns)\b/i.test(p) || (method !== "GET" && /^\/api\/servers\/[^/]+\/(stop|restart)$/.test(p));

export function createAssistant({ db, dataDir, run, baseUrl, repoRoot, agents = AGENTS, which, now = () => Date.now(), timeoutMs = 6 * 60_000 }) {
  const root = path.join(dataDir, "assistant");
  const tokens = new Map(); // sha(token) -> { userId, exp }
  const approvals = new Map(); // id -> { id, userId, method, path, summary, state, exp }
  const turns = new Map();
  let routes = [];

  const cfg = () => ({ ...DEFAULTS, ...JSON.parse(getSetting(db, "assistant", "{}") || "{}") });
  const histKey = (uid) => `assistant_chat_${uid}`;
  const history = (uid) => JSON.parse(getSetting(db, histKey(uid), "[]"));
  const pushHistory = (uid, ...msgs) => setSetting(db, histKey(uid), JSON.stringify([...history(uid), ...msgs].slice(-30)));

  async function resolveBin(id) {
    const a = agents[id];
    if (!a) return null;
    for (const b of a.bins()) if (await which?.(b) ?? await defaultWhich(b)) return b;
    return null;
  }

  async function status(user) {
    const c = cfg();
    const list = [];
    for (const [id, a] of Object.entries(agents)) list.push({ id, label: a.label, installed: Boolean(await resolveBin(id)), restricted: Boolean(a.restricted) });
    list.push({ id: "custom", label: "Custom command", installed: Boolean(c.custom.trim()), restricted: false });
    const cur = list.find((a) => a.id === c.agent);
    let canUse = c.enabled && Boolean(cur?.installed);
    let reason = !c.enabled ? "The assistant is off. An owner can turn it on in its settings." : !cur?.installed ? `${cur?.label ?? c.agent} isn't installed. Pick another agent or install it.` : "";
    // An agent that can't be limited to console-ctl could edit files directly, so only owners may use it.
    if (canUse && !cur.restricted && user.role !== "admin") { canUse = false; reason = "This agent isn't sandboxed, so only owners can use it. Ask an owner to switch to Claude Code."; }
    return { enabled: c.enabled, agent: c.agent, custom: user.role === "admin" ? c.custom : undefined, agents: user.role === "admin" ? list : undefined, canUse, reason, history: history(user.id), approvals: pendingFor(user.id) };
  }

  function configure(patch) {
    const next = { ...cfg() };
    if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
    if (typeof patch.agent === "string") { if (patch.agent !== "custom" && !agents[patch.agent]) throw new AssistantError("Unknown agent"); next.agent = patch.agent; }
    if (typeof patch.custom === "string") next.custom = patch.custom.slice(0, 500);
    setSetting(db, "assistant", JSON.stringify(next));
    return next;
  }

  // ---- short-lived tokens: the agent acts AS the asker, re-read from the database on every call ----
  const mint = (userId) => { const t = randomBytes(24).toString("base64url"); tokens.set(sha(t), { userId, exp: now() + TOKEN_MS }); return t; };
  const revoke = (t) => tokens.delete(sha(t));
  function userForToken(t) {
    const rec = tokens.get(sha(String(t ?? "")));
    if (!rec || rec.exp < now()) return null;
    return userById(db, rec.userId);
  }

  // ---- approvals ----
  const pendingFor = (uid) => [...approvals.values()].filter((a) => a.userId === uid && a.state === "pending" && a.exp > now()).map(({ id, summary, method, path: p }) => ({ id, summary, method, path: p }));
  function request(user, method, p, body) {
    for (const a of approvals.values()) if (a.userId === user.id && a.method === method && a.path === p && a.state === "pending" && a.exp > now()) return a;
    const id = randomBytes(6).toString("hex");
    const bit = body && typeof body === "object" && Object.keys(body).length ? ` ${JSON.stringify(body).slice(0, 120)}` : "";
    const a = { id, userId: user.id, method, path: p, summary: `${method} ${p}${bit}`, state: "pending", exp: now() + APPROVAL_MS };
    approvals.set(id, a);
    return a;
  }
  function consume(user, id, method, p) {
    const a = approvals.get(String(id ?? ""));
    if (!a || a.userId !== user.id || a.state !== "approved" || a.method !== method || a.path !== p || a.exp < now()) return false;
    approvals.delete(a.id);
    return true;
  }
  function decide(user, id, approve) {
    const a = approvals.get(id);
    if (!a || a.userId !== user.id || a.exp < now()) throw new AssistantError("That request has expired", 404);
    a.state = approve ? "approved" : "denied";
    return { id, state: a.state };
  }
  const approvalState = (user, id) => { const a = approvals.get(id); return a && a.userId === user.id ? { id, state: a.exp < now() ? "denied" : a.state } : { id, state: "denied" }; };

  // The gate every agent request passes through. Returns null to let it through, or { code, body } to stop it.
  function guard(req, user) {
    const p = req.url.split("?")[0];
    const method = req.method.toUpperCase();
    if (p === "/api/assistant/routes" || /^\/api\/assistant\/approvals\/[0-9a-f]+$/.test(p) && method === "GET") return null;
    if (AGENT_BLOCKED.some((re) => re.test(p))) return { code: 403, body: { error: "The assistant can't do that. Do it yourself in the panel." } };
    if (method !== "GET" && NEEDS_APPROVAL(method, p)) {
      if (consume(user, req.headers["x-approval"], method, p)) return null;
      const a = request(user, method, p, req.body);
      return { code: 409, body: { needsApproval: true, approvalId: a.id, summary: a.summary } };
    }
    return null;
  }

  function setRoutes(list) { routes = list; }
  const visibleRoutes = () => routes.filter((r) => r.url.startsWith("/api/") && !AGENT_BLOCKED.some((re) => re.test(r.url)) && !/^\/api\/assistant/.test(r.url)).sort((a, b) => a.url.localeCompare(b.url));

  // ---- chat turns ----
  async function ensureTool() {
    const dir = path.join(root, "bin");
    await mkdir(dir, { recursive: true });
    const sh = path.join(dir, "console-ctl");
    await writeFile(sh, `#!/bin/sh\nexec "${process.execPath}" "${path.join(repoRoot, "bin", "console-ctl.js")}" "$@"\n`);
    await chmod(sh, 0o755);
    await mkdir(path.join(root, "work"), { recursive: true });
    return { dir, work: path.join(root, "work") };
  }

  function promptFor(user, text) {
    const past = history(user.id).slice(-10).map((m) => `${m.role === "user" ? user.username : "You"}: ${m.text}`).join("\n");
    return `You are the assistant built into Console, a web panel for running game servers. You are talking to "${user.username}" (role: ${user.role}; permissions: ${user.role === "admin" ? "everything" : (user.perms ?? []).join(", ") || "none"}).

You act through ONE tool: the shell command console-ctl. Nothing else is available.
  console-ctl routes [text]                  list the panel's API routes (filter by a word, e.g. "players")
  console-ctl api METHOD /api/path ['{json}']  call one; replies with the HTTP status and body
Start by listing routes if you aren't sure which one to use. Call /api/servers first to learn server ids.

Rules:
- You can do exactly what ${user.username} can do in the panel and no more. If a call is refused (403), say so plainly; don't look for a way around it.
- Risky calls (stop, restart, delete, restore, DNS) pause until ${user.username} clicks Approve. Just make the call and wait.
- Never show tokens, passwords or keys. Don't try to manage users or sign-ins.
- Be short and plain, like a helpful friend who knows servers. Say what you did and what happened. If something failed, say why and what to try.
- If you're unsure what they want, ask one short question instead of guessing.
${past ? `\nConversation so far:\n${past}\n` : ""}
${user.username} says: ${text}`;
  }

  async function send(user, text) {
    text = String(text ?? "").trim().slice(0, 2000);
    if (!text) throw new AssistantError("Type something first");
    const st = await status(user);
    if (!st.canUse) throw new AssistantError(st.reason || "The assistant isn't available", 403);
    if ([...turns.values()].some((t) => t.userId === user.id && t.state === "running")) throw new AssistantError("Still working on your last message", 409);
    if ([...turns.values()].filter((t) => t.state === "running").length >= 3) throw new AssistantError("The assistant is busy, try again in a minute", 429);
    const c = cfg();
    const { dir, work } = await ensureTool();
    const token = mint(user.id);
    const id = randomBytes(5).toString("hex");
    const turn = { id, userId: user.id, state: "running", reply: "", at: now() };
    turns.set(id, turn);
    pushHistory(user.id, { role: "user", text, at: now() });
    const task = promptFor(user, text);
    const env = { PATH: `${dir}:${toolsBin()}:${process.env.PATH}`, CONSOLE_URL: baseUrl(), CONSOLE_AGENT_TOKEN: token, CONSOLE_TASK: task };
    (async () => {
      try {
        let cmd, args;
        if (c.agent === "custom") { cmd = "sh"; args = ["-c", c.custom]; }
        else { const bin = await resolveBin(c.agent); [cmd, ...args] = agents[c.agent].assist(bin, task); }
        const r = await run(cmd, args, { cwd: work, env, timeout: timeoutMs });
        const out = String(r.stdout ?? "").trim();
        turn.reply = (out || (r.code === 0 ? "Done." : `The agent stopped with an error.${r.stderr ? ` ${String(r.stderr).trim().slice(-300)}` : ""}`)).slice(-4000);
        turn.state = r.code === 0 || out ? "done" : "failed";
      } catch (e) { turn.reply = `Couldn't run the agent: ${e.message}`; turn.state = "failed"; }
      finally { revoke(token); for (const a of approvals.values()) if (a.userId === user.id && a.state === "pending") a.state = "denied"; pushHistory(user.id, { role: "assistant", text: turn.reply, at: now() }); }
    })();
    return { turnId: id };
  }

  const turn = (user, id) => { const t = turns.get(id); if (!t || t.userId !== user.id) return null; return { state: t.state, reply: t.reply, approvals: pendingFor(user.id) }; };
  const clear = (user) => setSetting(db, histKey(user.id), "[]");

  return { status, configure, send, turn, clear, userForToken, guard, decide, approvalState, setRoutes, visibleRoutes };
}

async function defaultWhich(bin) {
  const { existsSync } = await import("node:fs");
  if (path.isAbsolute(bin)) return existsSync(bin);
  const { spawnSync } = await import("node:child_process");
  return spawnSync("sh", ["-c", `command -v ${bin.replace(/[^\w.-]/g, "")}`]).status === 0;
}
