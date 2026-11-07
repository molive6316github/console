import { run, assertMatch } from "./exec.js";

const HOST = /^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
const UNIT = /^[a-zA-Z0-9][a-zA-Z0-9:_.@-]{0,127}$/;

// target: { host: "user@host", unit: "nginx.service", port?: 22, sudo?: true, keyFile?: "/path/to/key" }
// Needs key-based SSH from the machine running console. Needs passwordless sudo if sudo=true.
function sshArgs(target) {
  const host = assertMatch(target.host, HOST, "host");
  const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new"];
  if (target.port) args.push("-p", String(parseInt(target.port, 10)));
  if (target.keyFile) args.push("-i", String(target.keyFile));
  args.push(host);
  return args;
}

function remote(target, ...cmd) {
  const unit = assertMatch(target.unit, UNIT, "unit");
  const prefix = target.sudo ? ["sudo", "-n"] : [];
  // ssh joins the remote args into one shell string, but host and unit are
  // regex-validated and the verbs are hardcoded, so nothing injectable gets through.
  return [...sshArgs(target), ...prefix, "systemctl", ...cmd, unit];
}

export default {
  type: "systemd",
  async status(target) {
    const r = await run("ssh", remote(target, "is-active"), { timeout: 10_000 });
    const out = r.stdout.trim();
    if (out === "active") return "up";
    if (out === "inactive" || out === "failed" || out === "deactivating") return "down";
    return "unknown";
  },
  async start(target) {
    const r = await run("ssh", remote(target, "start"), { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "systemctl start failed");
  },
  async stop(target) {
    const r = await run("ssh", remote(target, "stop"), { timeout: 60_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "systemctl stop failed");
  },
  async restart(target) {
    const r = await run("ssh", remote(target, "restart"), { timeout: 90_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "systemctl restart failed");
  },
  async logs(target, lines = 200) {
    const unit = assertMatch(target.unit, UNIT, "unit");
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    const prefix = target.sudo ? ["sudo", "-n"] : [];
    const r = await run("ssh", [...sshArgs(target), ...prefix, "journalctl", "-u", unit, "-n", String(n), "--no-pager"], {
      timeout: 15_000,
    });
    return r.stdout + r.stderr;
  },
};
