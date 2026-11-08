import { run, sleep, assertMatch, clean, pickString, pickInt, pickPath } from "./exec.js";

const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// tmux wants "=name" (exact match) for session commands and "=name:" when the target is a pane.
// Plain "=name" works for has-session / kill-session but NOT for send-keys / capture-pane.
const sess = (s) => `=${s}`;
const pane = (s) => `=${s}:`;

// target: { session, startCommand, cwd?, stopCommand?, stopTimeoutSec?, filesRoot? }
// startCommand and stopCommand run on this machine as the console user. Only admins can set them.
async function hasSession(session) {
  const r = await run("tmux", ["has-session", "-t", sess(session)]);
  return r.code === 0;
}

// The session is kept after the program exits (remain-on-exit) so its last output and exit code survive.
// A session whose pane is dead means "the server stopped", not "the server is running".
async function paneInfo(session) {
  const r = await run("tmux", ["display-message", "-p", "-t", pane(session), "#{pane_dead} #{pane_dead_status}"]);
  if (r.code !== 0) return null;
  const [dead, status] = r.stdout.trim().split(" ");
  return { dead: dead === "1", exitCode: status === "" || status === undefined ? null : Number(status) };
}

async function isUp(session) {
  if (!(await hasSession(session))) return false;
  const p = await paneInfo(session);
  return !(p && p.dead);
}

async function sendLine(session, text) {
  const a = await run("tmux", ["send-keys", "-t", pane(session), "-l", "--", text]);
  if (a.code !== 0) throw new Error(a.stderr.trim() || "tmux send-keys failed");
  const b = await run("tmux", ["send-keys", "-t", pane(session), "Enter"]);
  if (b.code !== 0) throw new Error(b.stderr.trim() || "tmux send-keys failed");
}

async function stopSession(target) {
  const session = assertMatch(target.session, SESSION, "session name");
  if (!(await hasSession(session))) return;
  if (!(await isUp(session))) { await run("tmux", ["kill-session", "-t", sess(session)]); return; }
  if (target.stopCommand) {
    // e.g. "stop" for Minecraft: ask nicely, wait, then force.
    await sendLine(session, target.stopCommand).catch(() => {});
    const deadline = Date.now() + (target.stopTimeoutSec ?? 30) * 1000;
    while (Date.now() < deadline) {
      if (!(await isUp(session))) break;
      await sleep(1000);
    }
  }
  const r = await run("tmux", ["kill-session", "-t", sess(session)]);
  if (r.code !== 0 && (await hasSession(session))) throw new Error(r.stderr.trim() || "tmux kill-session failed");
}

async function startSession(target) {
  const session = assertMatch(target.session, SESSION, "session name");
  if (!target.startCommand) throw new Error("target.startCommand is required");
  if (await isUp(session)) return;
  // A leftover dead session (the server crashed earlier) is cleared before starting again.
  if (await hasSession(session)) await run("tmux", ["kill-session", "-t", sess(session)]);
  const args = ["new-session", "-d", "-s", session];
  if (target.cwd) args.push("-c", target.cwd);
  // Park the window on a placeholder, switch remain-on-exit on, and only then launch the real command in it.
  // That way even a command that dies instantly (bad Java path) leaves its error and exit code to read.
  args.push("sleep 86400", ";", "set-window-option", "-t", `${sess(session)}:`, "remain-on-exit", "on", ";", "respawn-pane", "-k", "-t", pane(session), target.startCommand);
  const r = await run("tmux", args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "tmux new-session failed");
}

export default {
  type: "tmux",
  supports: { logs: true, send: true },
  validate: (t) =>
    clean({
      session: pickString(t, "session", { re: SESSION, max: 64, required: true }),
      startCommand: pickString(t, "startCommand", { max: 2000, required: true }),
      cwd: pickPath(t, "cwd"),
      stopCommand: pickString(t, "stopCommand", { max: 500 }),
      stopTimeoutSec: pickInt(t, "stopTimeoutSec", 1, 600),
      filesRoot: pickPath(t, "filesRoot"),
    }),
  async status(target) {
    const session = assertMatch(target.session, SESSION, "session name");
    return (await isUp(session)) ? "up" : "down";
  },
  // Why it stopped, for the dashboard: null while running or if it was stopped cleanly with nothing left to show.
  async exitInfo(target) {
    const session = assertMatch(target.session, SESSION, "session name");
    if (!(await hasSession(session))) return null;
    const p = await paneInfo(session);
    return p && p.dead ? p : null;
  },
  start: startSession,
  stop: stopSession,
  async restart(target) {
    await stopSession(target);
    await startSession(target);
  },
  async logs(target, lines = 200) {
    const session = assertMatch(target.session, SESSION, "session name");
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    if (!(await hasSession(session))) return "";
    const info = await paneInfo(session);
    const r = await run("tmux", ["capture-pane", "-p", "-t", pane(session), "-S", `-${n}`]);
    // capture-pane pads the visible area with blank lines; trim them so the tail is the newest output
    const text = r.code === 0 ? r.stdout.replace(/\s+$/, "") + "\n" : "";
    return info?.dead ? `${text}\n[Console] The server process exited${info.exitCode === null ? "" : ` with code ${info.exitCode}`}. That is why it shows as stopped.\n` : text;
  },
  // Types one line into the session, like you would at the keyboard.
  async send(target, text) {
    const session = assertMatch(target.session, SESSION, "session name");
    if (typeof text !== "string" || !text.length || text.length > 1000 || /[\r\n\0]/.test(text)) {
      throw new Error("Command must be a single line of 1 to 1000 characters");
    }
    if (!(await isUp(session))) throw new Error("This server isn't running");
    await sendLine(session, text);
  },
};
