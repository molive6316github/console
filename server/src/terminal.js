import { getSetting, audit } from "./db.js";
import { userFromToken, hasRole } from "./auth.js";
import { toolsBin } from "./claudecode.js";

const MAX_SESSIONS = 3;
const IDLE_MS = 30 * 60_000;

// A shell in the browser. Off until an admin turns it on, admin-only, and it runs as whoever Console runs as.
// Sessions are recorded in the audit log (who, from where, how long). Keystrokes are NOT recorded: they'd capture passwords.
export function createTerminal({ db, loadPty = () => import("@lydell/node-pty"), shell = process.env.SHELL || "/bin/bash", idleMs = IDLE_MS, checkMs = 15_000, now = Date.now } = {}) {
  const sessions = new Set();
  let pty = null;
  let problem = null;

  async function ensurePty() {
    if (pty || problem) return;
    try {
      const mod = await loadPty();
      pty = mod.default ?? mod;
    } catch (e) {
      problem = `The terminal component couldn't load on this machine (${String(e.message).split("\n")[0]})`;
    }
  }

  const enabled = () => getSetting(db, "terminal_enabled", "0") === "1";

  // Secrets Console was started with must not be visible to someone typing `env` in the terminal.
  function cleanEnv() {
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k.startsWith("CONSOLE_") || k.startsWith("CF_") || k === "INVOCATION_ID" || k === "JOURNAL_STREAM") delete env[k];
    env.PATH = `${toolsBin()}:${env.PATH ?? "/usr/bin:/bin"}`; // Claude Code lives here
    return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
  }

  async function attach(socket, { user, token, ip, cols, rows, safeMode, run }) {
    await ensurePty();
    const send = (s) => socket.readyState === 1 && socket.send(s);
    if (!pty) {
      send(`\r\n${problem}\r\n`);
      return socket.close();
    }
    const clamp = (n, lo, hi, d) => (Number.isInteger(n) ? Math.min(Math.max(n, lo), hi) : d);
    const term = pty.spawn(shell, ["-l"], {
      name: "xterm-256color",
      cols: clamp(cols, 20, 400, 80),
      rows: clamp(rows, 5, 200, 24),
      cwd: process.env.HOME || "/",
      env: cleanEnv(),
    });
    if (run === "claude" && getSetting(db, "claude_code_enabled", "0") === "1") setTimeout(() => term.write("claude\r"), 400); // the only command that can be requested
    const started = now();
    let last = now();
    let closed = false;
    const session = { user: user.username, stop: (why) => finish(why) };
    sessions.add(session);
    audit(db, { username: user.username, action: "terminal_open", ok: true, detail: `from ${ip}` });

    function finish(why) {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      sessions.delete(session);
      try { term.kill(); } catch { /* already gone */ }
      if (why) send(`\r\n[${why}]\r\n`);
      try { socket.close(); } catch { /* ignore */ }
      audit(db, { username: user.username, action: "terminal_close", ok: true, detail: `${Math.round((now() - started) / 1000)}s${why ? `, ${why}` : ""}` });
    }

    // Re-check on a timer: signing out, being demoted, safe mode or the switch being turned off all end the session.
    const timer = setInterval(() => {
      const u = userFromToken(db, token);
      if (!u || !hasRole(u, "admin")) return finish("signed out");
      if (safeMode || !enabled()) return finish("terminal was turned off");
      if (now() - last > idleMs) return finish("closed after 30 minutes idle");
    }, checkMs);
    timer.unref?.();

    term.onData((d) => send(d));
    term.onExit(() => finish("shell exited"));
    socket.on("close", () => finish());
    socket.on("error", () => finish());
    socket.on("message", (raw) => {
      last = now();
      let m;
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m?.t === "in" && typeof m.d === "string" && m.d.length <= 65536) term.write(m.d);
      else if (m?.t === "resize") {
        const c = clamp(m.cols, 20, 400, null);
        const r = clamp(m.rows, 5, 200, null);
        if (c && r) try { term.resize(c, r); } catch { /* shell already gone */ }
      }
    });
  }

  return {
    enabled,
    attach,
    count: () => sessions.size,
    full: () => sessions.size >= MAX_SESSIONS,
    closeAll: (why) => [...sessions].forEach((s) => s.stop(why)),
    async available() {
      await ensurePty();
      return pty ? { ok: true } : { ok: false, reason: problem };
    },
  };
}
