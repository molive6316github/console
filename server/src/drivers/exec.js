import { execFile } from "node:child_process";

// Runs a command WITHOUT a shell. Never rejects: always resolves { code, stdout, stderr }.
export function run(cmd, args, { timeout = 10_000, cwd, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, env, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      let code = 0;
      if (err) code = typeof err.code === "number" ? err.code : 1;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? err?.message ?? "") });
    });
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function assertMatch(value, regex, label) {
  if (typeof value !== "string" || !regex.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}
