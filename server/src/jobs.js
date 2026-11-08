import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const MAX_LOG = 200_000;
const KEEP = 30;

export class JobFailure extends Error {}

// Long-running work (downloads, installs) that the browser follows by polling. Kept in memory: a restart clears them.
// Secrets must never be put in a log line; callers pass them through `env` and `redact`.
export function createJobs({ spawnImpl = spawn, now = Date.now } = {}) {
  const jobs = new Map();

  function start({ title, actor, redact = [] }, work) {
    const job = { id: randomBytes(6).toString("hex"), title, actor, status: "running", log: "", startedAt: now(), endedAt: null, result: null, error: null };
    const hide = (text) => redact.filter(Boolean).reduce((t, secret) => t.split(secret).join("••••"), text);
    const log = (line) => {
      job.log += hide(String(line)).replace(/\r/g, "") + "\n";
      if (job.log.length > MAX_LOG) job.log = "…(older output trimmed)\n" + job.log.slice(-MAX_LOG / 2);
    };
    const exec = (cmd, args, { cwd, env, input, allowFail = false, label } = {}) =>
      new Promise((resolve, reject) => {
        log(`$ ${label ?? [cmd, ...args].join(" ")}`);
        let child;
        try {
          child = spawnImpl(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
        } catch (e) {
          return allowFail ? resolve(1) : reject(new JobFailure(`Couldn't run ${cmd}: ${e.message}`));
        }
        let buf = "";
        const feed = (chunk) => {
          buf += chunk.toString();
          const parts = buf.split("\n");
          buf = parts.pop();
          parts.forEach((p) => p.trim() && log(p));
        };
        child.stdout.on("data", feed);
        child.stderr.on("data", feed);
        child.on("error", (e) => (allowFail ? resolve(127) : reject(new JobFailure(e.code === "ENOENT" ? `${cmd} is not installed` : `Couldn't run ${cmd}: ${e.message}`))));
        child.on("close", (code) => {
          if (buf.trim()) log(buf);
          if (code === 0 || allowFail) resolve(code ?? 1);
          else reject(new JobFailure(`${cmd} failed (exit ${code})`));
        });
        child.stdin.on("error", () => {});
        child.stdin.end(input ?? "");
      });
    jobs.set(job.id, job);
    for (const id of [...jobs.keys()].slice(0, Math.max(0, jobs.size - KEEP))) if (jobs.get(id).status !== "running") jobs.delete(id);
    Promise.resolve()
      .then(() => work({ log, exec }))
      .then((result) => ((job.status = "done"), (job.result = result ?? null)))
      .catch((e) => {
        job.status = "failed";
        job.error = hide(e instanceof JobFailure || e?.userFacing ? e.message : `Unexpected problem: ${e?.message ?? e}`);
        log(`✗ ${job.error}`);
      })
      .finally(() => (job.endedAt = now()));
    return job;
  }

  const view = (j, since = 0) => ({
    id: j.id, title: j.title, status: j.status, error: j.error, result: j.result,
    startedAt: j.startedAt, endedAt: j.endedAt, offset: j.log.length, log: j.log.slice(since),
  });
  return {
    start,
    get: (id, since = 0) => (jobs.has(id) ? view(jobs.get(id), since) : null),
    list: () => [...jobs.values()].reverse().map((j) => ({ ...view(j), log: undefined, offset: undefined })),
    running: () => [...jobs.values()].filter((j) => j.status === "running").length,
  };
}
