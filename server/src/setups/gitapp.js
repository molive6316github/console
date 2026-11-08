import { readFile, writeFile, mkdir, access, chmod } from "node:fs/promises";
import path from "node:path";
import { SetupError, nameAndId, str, parseEnvText, shq, commandExists, fail } from "./common.js";
import { parseRepo, validBranch, gitEnv, tokenSecrets, RepoError } from "../gitutil.js";

const exists = (p) => access(p).then(() => true, () => false);

export async function detectProject(dir) {
  if (await exists(path.join(dir, "package.json"))) {
    let pkg = {};
    try { pkg = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")); } catch { /* bad package.json */ }
    let start = null;
    if (pkg.scripts?.start) start = "npm start";
    else if (pkg.main) start = `node ${shq(pkg.main)}`;
    else for (const f of ["index.js", "bot.js", "server.js", "app.js", "main.js"]) if (await exists(path.join(dir, f))) { start = `node ${f}`; break; }
    return { kind: "node", start };
  }
  if ((await exists(path.join(dir, "requirements.txt"))) || (await exists(path.join(dir, "pyproject.toml")))) {
    let start = null;
    for (const f of ["bot.py", "main.py", "app.py", "run.py", "server.py"]) if (await exists(path.join(dir, f))) { start = `python ${f}`; break; }
    return { kind: "python", start };
  }
  for (const f of ["main.py", "bot.py", "app.py"]) if (await exists(path.join(dir, f))) return { kind: "python", start: `python ${f}` };
  return { kind: "unknown", start: null };
}

export function buildStart({ dir, command, kind, autoRestart }) {
  const venv = kind === "python" ? ' export PATH="$PWD/.venv/bin:$PATH";' : "";
  const prelude = `cd ${shq(dir)} &&${venv} set -a; [ ! -f .env ] || . ./.env; set +a;`;
  if (!autoRestart) return `${prelude} ${command}; echo "[console] exited with code $?"`;
  return `${prelude} while true; do ${command}; echo "[console] exited with code $?, restarting in 5s"; sleep 5; done`;
}

export async function installDeps(dir, kind, ctx) {
  if (kind === "node") {
    if (!(await commandExists(ctx.run, "npm"))) throw fail("npm isn't installed on this server.");
    await ctx.exec("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: dir });
  } else if (kind === "python") {
    if (!(await commandExists(ctx.run, "python3"))) throw fail("python3 isn't installed on this server.");
    await ctx.exec("python3", ["-m", "venv", ".venv"], { cwd: dir });
    if (await exists(path.join(dir, "requirements.txt"))) await ctx.exec(path.join(dir, ".venv/bin/pip"), ["install", "-r", "requirements.txt"], { cwd: dir });
    else if (await exists(path.join(dir, "pyproject.toml"))) await ctx.exec(path.join(dir, ".venv/bin/pip"), ["install", "."], { cwd: dir });
  }
}

export async function cloneRepo(ctx, env, repo, branch, dest) {
  const args = ["clone", "--depth", "1", ...(branch ? ["--branch", branch] : []), repo.url, dest];
  const code = await ctx.exec("git", args, { env: gitEnv(env.token, repo.host), allowFail: true });
  if (code !== 0) {
    throw fail(
      env.token
        ? "Couldn't download that repository. Check the name and branch, and that your saved GitHub token can read it."
        : "Couldn't download that repository. If it's private, save a GitHub token in Settings first."
    );
  }
}

export default {
  id: "git-app",
  title: "App or bot from GitHub",
  blurb: "Node.js or Python. Paste a GitHub link and Console downloads it, installs it and keeps it running.",
  category: "Apps",
  level: "simple",
  fields: [
    { key: "repo", label: "GitHub link or owner/repo", type: "text", required: true, placeholder: "me/my-discord-bot" },
    { key: "name", label: "Name", type: "text", help: "Defaults to the repo name." },
    { key: "branch", label: "Branch", type: "text", level: "standard", help: "Leave blank for the default branch." },
    { key: "envText", label: "Settings / secrets (.env)", type: "textarea", level: "standard", help: "One NAME=value per line, like DISCORD_TOKEN=abc. Saved to a private .env file, never shown again." },
    { key: "startCommand", label: "Start command", type: "text", level: "standard", help: "Leave blank and Console works it out (npm start, node index.js, python bot.py…)." },
    { key: "autoRestart", label: "Restart it automatically if it crashes", type: "checkbox", default: true, level: "standard" },
    { key: "id", label: "ID", type: "text", level: "advanced" },
  ],
  validate(inp, env) {
    let repo;
    try { repo = parseRepo(inp.repo); } catch (e) { if (e instanceof RepoError) throw new SetupError(e.message); throw e; }
    const { name, id } = nameAndId({ ...inp, name: str(inp.name, 80) || repo.repo }, env.db, repo.repo);
    const branch = str(inp.branch, 100);
    if (branch && !validBranch(branch)) throw new SetupError("That branch name isn't allowed");
    const startCommand = str(inp.startCommand, 500);
    if (/[\n\r\0]/.test(startCommand)) throw new SetupError("The start command must be a single line");
    return { repo, name, id, branch, startCommand, env: parseEnvText(inp.envText), autoRestart: inp.autoRestart !== false };
  },
  async run(c, ctx, env) {
    if (!(await commandExists(env.run, "git"))) throw fail("git isn't installed on this server.");
    const dir = path.join(env.appsDir, c.id);
    if (await exists(dir)) throw fail(`${dir} already exists. Pick another name or remove that folder first.`);
    await mkdir(env.appsDir, { recursive: true });
    ctx.log(`Downloading ${c.repo.slug}…`);
    await cloneRepo(ctx, env, c.repo, c.branch, dir);
    const found = await detectProject(dir);
    if (found.kind === "unknown") throw fail("I couldn't tell what this is. Console supports Node.js (package.json) and Python (requirements.txt or main.py) projects.");
    ctx.log(`Looks like a ${found.kind === "node" ? "Node.js" : "Python"} project.`);
    await installDeps(dir, found.kind, { exec: ctx.exec, run: env.run });
    if (c.env.length) {
      const file = path.join(dir, ".env");
      await writeFile(file, c.env.map(([k, v]) => `${k}=${shq(v)}`).join("\n") + "\n", { mode: 0o600 });
      await chmod(file, 0o600);
      ctx.log(`Saved ${c.env.length} setting${c.env.length === 1 ? "" : "s"} to a private .env file.`);
    }
    let command = c.startCommand || found.start;
    if (!command) throw fail("I couldn't work out how to start it. Run the setup again and fill in the 'Start command' box.");
    ctx.log(`Start command: ${command}`);
    env.saveMeta(c.id, { kind: found.kind, repo: c.repo.slug, branch: c.branch || null, dir, startCommand: command, autoRestart: c.autoRestart });
    return {
      id: c.id,
      name: c.name,
      type: "tmux",
      target: {
        session: c.id.slice(0, 64),
        startCommand: buildStart({ dir, command, kind: found.kind, autoRestart: c.autoRestart }),
        cwd: dir,
        stopCommand: undefined,
        filesRoot: dir,
      },
      note: c.autoRestart ? "It restarts itself 5 seconds after a crash. Press Stop to turn it off for good." : undefined,
    };
  },
  secrets: (env) => tokenSecrets(env.token),
};

// Pull the latest code and reinstall. Used by the "Update from GitHub" button.
export async function updateFromGit({ meta, ctx, env }) {
  const dir = meta.dir;
  if (!(await exists(path.join(dir, ".git")))) throw fail("That folder isn't a git checkout anymore.");
  const repo = parseRepo(meta.repo);
  const before = (await env.run("git", ["-C", dir, "rev-parse", "--short", "HEAD"])).stdout.trim();
  const code = await ctx.exec("git", ["-C", dir, "pull", "--ff-only"], { env: gitEnv(env.token, repo.host), allowFail: true });
  if (code !== 0) throw fail("Couldn't pull. The folder may have local changes, or the saved GitHub token can't read this repo.");
  const after = (await env.run("git", ["-C", dir, "rev-parse", "--short", "HEAD"])).stdout.trim();
  if (before === after) { ctx.log("Already up to date."); return { changed: false }; }
  ctx.log(`Updated ${before} -> ${after}`);
  if (meta.kind === "node" || meta.kind === "python") await installDeps(dir, meta.kind, { exec: ctx.exec, run: env.run });
  return { changed: true };
}
