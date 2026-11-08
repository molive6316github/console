import { run, assertMatch, clean, pickString, pickInt, pickPath } from "./exec.js";

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

// host "local" means this machine: run systemctl directly instead of over SSH.
// Starting/stopping system services as the console user needs a sudoers rule (set sudo: true).
export const isLocal = (target) => target.host === "local";

// Returns [binary, args] for `systemctl <verb> <unit>`.
function invoke(target, verb) {
  const unit = assertMatch(target.unit, UNIT, "unit");
  const prefix = target.sudo ? ["sudo", "-n"] : [];
  if (isLocal(target)) return prefix.length ? ["sudo", ["-n", "systemctl", verb, unit]] : ["systemctl", [verb, unit]];
  // ssh joins the remote args into one shell string, but host and unit are
  // regex-validated and the verbs are hardcoded, so nothing injectable gets through.
  return ["ssh", [...sshArgs(target), ...prefix, "systemctl", verb, unit]];
}

function permissionHint(target, text) {
  if (isLocal(target) && /sudo|password|authentication|interactive|permission|access denied/i.test(text)) {
    return `${text.trim()}\nConsole runs as the "console" user. Allow it to control this service, e.g. add to /etc/sudoers.d/console: console ALL=(root) NOPASSWD: /usr/bin/systemctl start ${target.unit}, /usr/bin/systemctl stop ${target.unit}, /usr/bin/systemctl restart ${target.unit}  (and turn on "Use sudo").`;
  }
  return text.trim();
}

export default {
  type: "systemd",
  validate: (t) =>
    clean({
      host: pickString(t, "host", { re: HOST, max: 255, required: true }),
      unit: pickString(t, "unit", { re: UNIT, max: 128, required: true }),
      port: pickInt(t, "port", 1, 65535),
      sudo: t.sudo === undefined ? undefined : Boolean(t.sudo),
      keyFile: pickPath(t, "keyFile"),
    }),
  async status(target) {
    const r = await run(...invoke(target, "is-active"), { timeout: 10_000 });
    const out = r.stdout.trim();
    if (out === "active") return "up";
    if (out === "inactive" || out === "failed" || out === "deactivating") return "down";
    return "unknown";
  },
  async start(target) {
    const r = await run(...invoke(target, "start"), { timeout: 60_000 });
    if (r.code !== 0) throw new Error(permissionHint(target, r.stderr) || "systemctl start failed");
  },
  async stop(target) {
    const r = await run(...invoke(target, "stop"), { timeout: 60_000 });
    if (r.code !== 0) throw new Error(permissionHint(target, r.stderr) || "systemctl stop failed");
  },
  async restart(target) {
    const r = await run(...invoke(target, "restart"), { timeout: 90_000 });
    if (r.code !== 0) throw new Error(permissionHint(target, r.stderr) || "systemctl restart failed");
  },
  async logs(target, lines = 200) {
    const unit = assertMatch(target.unit, UNIT, "unit");
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 2000);
    const prefix = target.sudo ? ["sudo", "-n"] : [];
    const jargs = ["journalctl", "-u", unit, "-n", String(n), "--no-pager"];
    const r = isLocal(target)
      ? await run(...(prefix.length ? ["sudo", ["-n", ...jargs]] : [jargs[0], jargs.slice(1)]), { timeout: 15_000 })
      : await run("ssh", [...sshArgs(target), ...prefix, ...jargs], { timeout: 15_000 });
    return r.stdout + r.stderr;
  },
};
