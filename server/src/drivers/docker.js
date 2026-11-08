import { run, assertMatch, clean, pickString, pickPath } from "./exec.js";

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

// target: { container: "name-or-id" }
export default {
  type: "docker",
  validate: (t) =>
    clean({ container: pickString(t, "container", { re: NAME, max: 128, required: true }), filesRoot: pickPath(t, "filesRoot") }),
  async status(target) {
    const c = assertMatch(target.container, NAME, "container name");
    const r = await run("docker", ["inspect", "-f", "{{.State.Running}}", c]);
    if (r.code !== 0) return "unknown";
    return r.stdout.trim() === "true" ? "up" : "down";
  },
  async start(target) {
    const c = assertMatch(target.container, NAME, "container name");
    const r = await run("docker", ["start", c], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "docker start failed");
  },
  async stop(target) {
    const c = assertMatch(target.container, NAME, "container name");
    const r = await run("docker", ["stop", c], { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "docker stop failed");
  },
  async restart(target) {
    const c = assertMatch(target.container, NAME, "container name");
    const r = await run("docker", ["restart", c], { timeout: 90_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "docker restart failed");
  },
  async logs(target, lines = 200) {
    const c = assertMatch(target.container, NAME, "container name");
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    const r = await run("docker", ["logs", "--tail", String(n), c]);
    return r.stdout + r.stderr;
  },
};
