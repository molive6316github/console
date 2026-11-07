import { run, sleep, assertMatch } from "./exec.js";

const SESSION = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

// target: { session, startCommand, cwd?, stopCommand?, stopTimeoutSec? }
// startCommand and stopCommand come from servers.json, which only the machine owner edits.
async function isUp(session) {
  const r = await run("tmux", ["has-session", "-t", `=${session}`]);
  return r.code === 0;
}

async function stopSession(target) {
  const session = assertMatch(target.session, SESSION, "session name");
  if (!(await isUp(session))) return;
  if (target.stopCommand) {
    // e.g. "stop" for Minecraft: ask nicely, wait, then force.
    await run("tmux", ["send-keys", "-t", `=${session}`, "-l", target.stopCommand]);
    await run("tmux", ["send-keys", "-t", `=${session}`, "Enter"]);
    const deadline = Date.now() + (target.stopTimeoutSec ?? 30) * 1000;
    while (Date.now() < deadline) {
      if (!(await isUp(session))) return;
      await sleep(1000);
    }
  }
  const r = await run("tmux", ["kill-session", "-t", `=${session}`]);
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
    const r = await run("tmux", ["capture-pane", "-p", "-t", `=${session}`, "-S", `-${n}`]);
    return r.code === 0 ? r.stdout : "";
  },
};
