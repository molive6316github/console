import os from "node:os";
import path from "node:path";
import { getSetting, setSetting, getServer, audit } from "../db.js";
import { run as defaultRun } from "../drivers/exec.js";
import { SetupError, commandExists, findJava, javaMajorOf } from "./common.js";
import minecraft, { listVersions, FLAVORS } from "./minecraft.js";
import dockerApps from "./dockerapps.js";
import gitApp, { updateFromGit } from "./gitapp.js";
import staticSite from "./staticsite.js";
import { tokenSecrets } from "../gitutil.js";
import { JobFailure } from "../jobs.js";

const TEMPLATES = [minecraft, gitApp, staticSite, dockerApps];

export function createSetups({ db, jobs, startServer, restartServer, fetchImpl = fetch, run = defaultRun, appsDir, caddy, publicIp, user, jvmDir }) {
  const env = () => ({
    db,
    run,
    fetch: fetchImpl,
    appsDir,
    caddy,
    publicIp,
    user,
    token: getSetting(db, "github_token", "") || "",
    saveMeta: (id, meta) => setSetting(db, `app.${id}`, JSON.stringify(meta)),
  });
  const metaOf = (id) => {
    try { return JSON.parse(getSetting(db, `app.${id}`, "") || "null"); } catch { return null; }
  };

  const catalog = () => TEMPLATES.map(({ id, title, blurb, category, level, fields }) => ({ id, title, blurb, category, level, fields }));

  // Validates synchronously (so the form can show the mistake), then does the slow part as a job.
  function start(templateId, inputs, actor) {
    const t = TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw new SetupError("Unknown setup");
    const e = env();
    const clean = t.validate(inputs ?? {}, e);
    const job = jobs.start({ title: `${t.title}: ${clean.name}`, actor, redact: tokenSecrets(e.token) }, async (ctx) => {
      const row = await t.run(clean, ctx, e);
      const existing = getServer(db, row.id);
      if (existing) throw new JobFailure(`"${row.id}" was taken while this was running`);
      db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES (?, ?, ?, ?, 'ui')").run(row.id, row.name, row.type, JSON.stringify(JSON.parse(JSON.stringify(row.target))));
      audit(db, { username: actor, serverId: row.id, action: "setup", ok: true, detail: `${t.id}` });
      ctx.log(`✓ Added "${row.name}" to Console`);
      if (row.type === "tmux" && startServer) {
        ctx.log("Starting it…");
        await startServer(row.id, actor).catch((err) => ctx.log(`Couldn't start it automatically: ${err.message}`));
      }
      if (row.note) ctx.log(row.note);
      return { serverId: row.id, note: row.note ?? null };
    });
    audit(db, { username: actor, action: "setup_start", ok: true, detail: `${t.id}: ${clean.name}` });
    return job;
  }

  function updateApp(serverId, actor) {
    const meta = metaOf(serverId);
    const server = getServer(db, serverId);
    if (!meta || !server) throw new SetupError("Console didn't set this up from GitHub, so it can't update it");
    const e = env();
    return jobs.start({ title: `Update ${server.name} from GitHub`, actor, redact: tokenSecrets(e.token) }, async (ctx) => {
      const r = await updateFromGit({ meta, ctx: { ...ctx, run }, env: e });
      if (meta.kind === "static") {
        ctx.log("Done. Static sites update instantly, no restart needed.");
      } else if (r.changed && restartServer) {
        ctx.log("Restarting…");
        await restartServer(serverId, actor);
      }
      audit(db, { username: actor, serverId, action: "git_update", ok: true, detail: r.changed ? "updated" : "no change" });
      return r;
    });
  }

  async function status() {
    const [git, npm, python, tmux, docker, caddyBin, sudo, javaCmd] = await Promise.all(
      ["git", "npm", "python3", "tmux", "docker", "caddy"].map((c) => commandExists(run, c)).concat([run("sudo", ["-n", "true"]).then((r) => r.code === 0), findJava(run, 0, jvmDir)])
    );
    return {
      user: user ?? os.userInfo().username,
      appsDir,
      publicIp: publicIp || null,
      sudo,
      git, npm, python, tmux, docker, caddy: caddyBin,
      java: javaCmd?.major ?? null,
      githubToken: Boolean(getSetting(db, "github_token", "")),
    };
  }

  return { catalog, start, updateApp, status, metaOf, versions: (flavor) => listVersions(fetchImpl, flavor), flavors: FLAVORS, templates: TEMPLATES };
}

export { SetupError };
