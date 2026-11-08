import { execFile } from "node:child_process";

// Runs a command WITHOUT a shell. Never rejects: always resolves { code, stdout, stderr }.
export function run(cmd, args, { timeout = 10_000, cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout, cwd, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
    });
    // `input` goes to stdin as data: it is never part of the command line.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input ?? ""); // always close stdin so nothing waits on it forever
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertMatch(value, regex, label) {
  if (typeof value !== "string" || !regex.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

// ---- target validation helpers (used by every driver's validate()) ----------
export class TargetError extends Error {}

export function pickString(t, key, { re, max = 500, required = false } = {}) {
  const v = t[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new TargetError(`${key} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length > max || v.includes("\0")) throw new TargetError(`${key} is not valid`);
  if (re && !re.test(v)) throw new TargetError(`${key} is not valid`);
  return v;
}

export function pickInt(t, key, min, max) {
  const v = t[key];
  if (v === undefined || v === null || v === "") return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new TargetError(`${key} must be a whole number from ${min} to ${max}`);
  return n;
}

export function pickPath(t, key) {
  const v = pickString(t, key, { max: 1024 });
  if (v === undefined) return undefined;
  if (!v.startsWith("/") || v === "/" || v.split("/").includes("..")) {
    throw new TargetError(`${key} must be an absolute path (not "/") with no ".." in it`);
  }
  return v.replace(/\/+$/, "");
}

export function clean(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
