import { promises as fs, createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { McError, parse } from "./props.js";
import { parseRepo, gitEnv, tokenSecrets, RepoError } from "../gitutil.js";
import { run } from "../drivers/exec.js";

const UA = "molive6316github-console (minecraft backups)";
const CONFIG_EXT = /\.(ya?ml|json|toml|properties|conf|cfg|txt|ini)$/i;
const SKIP_DIR = /^(cache|logs|crash-reports|libraries|versions|world[\w-]*|backups|old-worlds|\.git|node_modules|\.paper-remapped|\.console[\w-]*)$/i;
const SECRET_LINE = /^(\s*(?:["']?[\w.-]*(?:pass(?:word|wd)?|secret|token|api[-_]?key|private[-_]?key|rcon\.password|webhook)[\w.-]*["']?)\s*[:=]\s*)(.*\S.*)$/i;
const MAX_FILE = 512 * 1024;
const MAX_FILES = 800;

export function redactText(text) {
  let n = 0;
  const out = text.split("\n").map((line) => {
    const m = line.match(SECRET_LINE);
    if (!m || /^\s*#/.test(line)) return line;
    n++;
    return `${m[1]}REDACTED-BY-CONSOLE`;
  });
  return { text: out.join("\n"), count: n };
}

// Copies the files worth versioning (settings, lists, plugin/mod configs) into outDir with secrets blanked. Never touches the worlds or jars.
export async function collectConfig(root, outDir) {
  const files = [];
  let redacted = 0;
  const copy = async (rel) => {
    if (files.length >= MAX_FILES) return;
    const from = path.join(root, rel);
    const st = await fs.lstat(from).catch(() => null);
    if (!st || !st.isFile() || st.size > MAX_FILE) return;
    let text;
    try {
      text = await fs.readFile(from, "utf8");
    } catch {
      return;
    }
    if (text.includes("\0")) return;
    const r = redactText(text);
    redacted += r.count;
    const to = path.join(outDir, rel);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, r.text);
    files.push(rel);
  };
  const walk = async (rel, depth) => {
    if (depth > 6) return;
    const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = path.join(rel, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIR.test(e.name)) await walk(r, depth + 1);
      } else if (e.isFile() && CONFIG_EXT.test(e.name)) await copy(r);
    }
  };
  for (const f of ["server.properties", "whitelist.json", "ops.json", "banned-players.json", "banned-ips.json", "bukkit.yml", "spigot.yml", "paper.yml", "eula.txt"]) await copy(f);
  await walk("config", 0);
  await walk("plugins", 0);
  await walk("mods", 0); // only config-like files; jars are skipped by the extension filter
  return { files, redacted };
}

function ghHeaders(token, extra = {}) {
  return { "user-agent": UA, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function api(fetchImpl, token, method, url, body) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers: ghHeaders(token, body ? { "content-type": "application/json" } : {}), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new McError(`Couldn't reach GitHub: ${e.message}`, 502);
  }
  if (res.status === 401) throw new McError("GitHub rejected the token. Save a fresh one in Settings.", 502);
  if (res.status === 403 || res.status === 404) throw new McError("GitHub says no. The token needs write access (\"Contents\") to that repo.", 502);
  if (res.status === 422) throw new McError("GitHub refused that. A brand-new empty repo needs one commit first. Run the config backup once, then try again.", 502);
  if (!res.ok) throw new McError(`GitHub answered ${res.status}`, 502);
  return res.status === 204 ? null : res.json();
}

export function repoOf(input) {
  try {
    const r = parseRepo(input);
    if (r.host !== "github.com") throw new McError("Backups only go to github.com repos");
    return r;
  } catch (e) {
    if (e instanceof RepoError) throw new McError(e.message);
    throw e;
  }
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// Commits the (redacted) configs to branch servers/<id> of the repo.
export async function pushConfig({ ctx, root, serverId, repoInput, token, workDir }) {
  const repo = repoOf(repoInput);
  const env = gitEnv(token);
  const branch = `servers/${serverId}`;
  const git = (args, opts = {}) => ctx.exec("git", ["-c", "user.name=Console", "-c", "user.email=console@localhost", "-c", "commit.gpgsign=false", ...args], { cwd: workDir, env, ...opts });
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 });
  await git(["init", "-q"]);
  await git(["remote", "add", "origin", repo.url]);
  const remoteHas = (await git(["fetch", "--depth", "1", "origin", branch], { allowFail: true })) === 0;
  if (remoteHas) await git(["checkout", "-q", "-B", branch, "FETCH_HEAD"]);
  else await git(["checkout", "-q", "-b", branch]);
  for (const e of await fs.readdir(workDir)) if (e !== ".git") await fs.rm(path.join(workDir, e), { recursive: true, force: true });
  const { files, redacted } = await collectConfig(root, workDir);
  ctx.log(`Collected ${files.length} config file(s); blanked ${redacted} secret-looking line(s).`);
  if (redacted) ctx.log("Heads up: secret blanking is a best guess. Keep this repo private.");
  await git(["add", "-A"]);
  const clean = (await git(["diff", "--cached", "--quiet"], { allowFail: true })) === 0;
  if (clean && remoteHas) {
    ctx.log("Nothing changed since the last backup.");
    return { changed: false, files: files.length, branch };
  }
  await git(["commit", "-q", "-m", `Config backup ${new Date().toISOString()}`]);
  await git(["push", "-q", "origin", `HEAD:refs/heads/${branch}`]);
  ctx.log(`Pushed to ${repo.slug} (${branch}).`);
  return { changed: true, files: files.length, redacted, branch, repo: repo.slug };
}

// Packs the world folders, uploads the tarball as a GitHub release asset, and removes releases past `keep`.
export async function pushWorld({ ctx, root, serverId, repoInput, token, keep, fetchImpl, tmpDir, pause }) {
  const repo = repoOf(repoInput);
  if (!token) throw new McError("Save a GitHub token in Settings first");
  const props = parse(await fs.readFile(path.join(root, "server.properties"), "utf8")).values;
  const level = props["level-name"] || "world";
  if (!/^[A-Za-z0-9._-]+$/.test(level) || level.includes("..")) throw new McError("The world folder name in server.properties isn't safe to back up");
  const dirs = [level, `${level}_nether`, `${level}_the_end`].filter((d) => existsSync(path.join(root, d)));
  if (!dirs.length) throw new McError("There's no world folder yet");
  await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
  const tag = `world-${serverId}-${stamp()}`;
  const file = path.join(tmpDir, `${tag}.tar.gz`);
  let resume = null;
  try {
    ctx.log("Pausing world saving and flushing to disk…");
    resume = await pause?.();
    await ctx.exec("tar", ["-czf", file, "-C", root, ...dirs]);
  } finally {
    await resume?.();
    if (resume) ctx.log("World saving is back on.");
  }
  try {
    const size = (await fs.stat(file)).size;
    if (size > 2 * 1024 ** 3 - 1) throw new McError("The world is over GitHub's 2 GB limit for a release file. Use a local backup instead.");
    ctx.log(`Packed ${Math.round(size / 1048576)} MB. Creating release ${tag}…`);
    const rel = await api(fetchImpl, token, "POST", `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases`, { tag_name: tag, name: tag, prerelease: true, body: "World backup made by Console." });
    let res;
    try {
      res = await fetchImpl(`https://uploads.github.com/repos/${repo.owner}/${repo.repo}/releases/${rel.id}/assets?name=${encodeURIComponent(`${tag}.tar.gz`)}`, {
        method: "POST",
        headers: ghHeaders(token, { "content-type": "application/gzip", "content-length": String(size) }),
        body: Readable.toWeb(createReadStream(file)),
        duplex: "half",
      });
    } catch (e) {
      throw new McError(`Upload failed: ${e.message}`, 502);
    }
    if (!res.ok) throw new McError(`GitHub refused the upload (${res.status})`, 502);
    ctx.log("Uploaded.");
    const pruned = await pruneWorlds({ fetchImpl, token, repo, serverId, keep });
    if (pruned) ctx.log(`Removed ${pruned} older world backup(s).`);
    return { tag, size, pruned, repo: repo.slug };
  } finally {
    await fs.rm(file, { force: true });
  }
}

export async function pruneWorlds({ fetchImpl, token, repo, serverId, keep }) {
  const list = await api(fetchImpl, token, "GET", `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100`);
  const prefix = `world-${serverId}-`;
  const mine = list.filter((r) => typeof r.tag_name === "string" && r.tag_name.startsWith(prefix)).sort((a, b) => String(b.tag_name).localeCompare(String(a.tag_name)));
  let n = 0;
  for (const r of mine.slice(Math.max(1, keep))) {
    await api(fetchImpl, token, "DELETE", `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/${r.id}`);
    await api(fetchImpl, token, "DELETE", `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/refs/tags/${encodeURIComponent(r.tag_name)}`).catch(() => {});
    n++;
  }
  return n;
}
void tokenSecrets;
