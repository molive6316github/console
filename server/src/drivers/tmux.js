import { run, sleep, assertMatch, clean, pickString, pickInt, pickPath } from "./exec.js";

const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// tmux wants "=name" (exact match) for session commands and "=name:" when the target is a pane.
// Plain "=name" works for has-session / kill-session but NOT for send-keys / capture-pane.
const sess = (s) => `=${s}`;
const pane = (s) => `=${s}:`;

// target: { session, startCommand, cwd?, stopCommand?, stopTimeoutSec?, filesRoot? }
// startCommand and stopCommand run on this machine as the console user. Only admins can set them.
async function isUp(session) {
  const r = await run("tmux", ["has-session", "-t", sess(session)]);
  return r.code === 0;
}

async function sendLine(session, text) {
  const a = await run("tmux", ["send-keys", "-t", pane(session), "-l", "--", text]);
  if (a.code !== 0) throw new Error(a.stderr.trim() || "tmux send-keys failed");
  const b = await run("tmux", ["send-keys", "-t", pane(session), "Enter"]);
  if (b.code !== 0) throw new Error(b.stderr.trim() || "tmux send-keys failed");
}

async function stopSession(target) {
  const session = assertMatch(target.session, SESSION, "session name");
  if (!(await isUp(session))) return;
  if (target.stopCommand) {
    // e.g. "stop" for Minecraft: ask nicely, wait, then force.
    await sendLine(session, target.stopCommand).catch(() => {});
    const deadline = Date.now() + (target.stopTimeoutSec ?? 30) * 1000;
    while (Date.now() < deadline) {
      if (!(await isUp(session))) return;
      await sleep(1000);
    }
  }
  const r = await run("tmux", ["kill-session", "-t", sess(session)]);
  if (r.code !== 0 && (await isUp(session))) throw new Error(r.stderr.trim() || "tmux kill-session failed");
}

async function startSession(target) {
  const session = assertMatch(target.session, SESSION, "session name");
  if (!target.startCommand) throw new Error("target.startCommand is required");
  if (await isUp(session)) return;
  const args = ["new-session", "-d", "-s", session];
  if (target.cwd) args.push("-c", target.cwd);
  args.push(target.startCommand);
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
  start: startSession,
  stop: stopSession,
  async restart(target) {
    await stopSession(target);
    await startSession(target);
  },
  async logs(target, lines = 200) {
    const session = assertMatch(target.session, SESSION, "session name");
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    if (!(await isUp(session))) return "";
    const r = await run("tmux", ["capture-pane", "-p", "-t", pane(session), "-S", `-${n}`]);
    // capture-pane pads the visible area with blank lines; trim them so the tail is the newest output
    return r.code === 0 ? r.stdout.replace(/\s+$/, "") + "\n" : "";
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
