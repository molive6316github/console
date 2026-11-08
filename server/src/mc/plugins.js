import { createWriteStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { McError } from "./props.js";
import { parseRepo, RepoError } from "../gitutil.js";
import { CATALOG, CATEGORIES, BUNDLES, catalogSlugs } from "./catalog.js";

const UA = "molive6316github-console (minecraft plugin manager)";
const JAR = /^[A-Za-z0-9][A-Za-z0-9._+() \-]{0,150}\.jar(\.disabled)?$/;
const MODRINTH_HOSTS = ["cdn.modrinth.com"];
const GH_ASSET_HOSTS = ["objects.githubusercontent.com", "release-assets.githubusercontent.com", "github-releases.githubusercontent.com"];
const MAX_BYTES = 150 * 1024 * 1024;

export const safeJarName = (n) => {
  const base = path.basename(String(n ?? "")).replace(/[^A-Za-z0-9._+() -]/g, "_").replace(/^[._-]+/, "");
  return base.endsWith(".jar") ? base.slice(0, 160) : `${base.slice(0, 150)}.jar`;
};

async function getJson(fetchImpl, url, headers = {}) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": UA, accept: "application/json", ...headers }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new McError(`Couldn't reach ${new URL(url).hostname}: ${e.message}`, 502);
  }
  if (res.status === 404) throw new McError("Not found (check the name, and that your GitHub token can see it)", 404);
  if (res.status === 401 || res.status === 403) throw new McError(res.status === 401 ? "GitHub rejected the token. Save a fresh one in Settings." : "Access denied or rate-limited. A GitHub token in Settings raises the limit and unlocks private repos.", 502);
  if (!res.ok) throw new McError(`${new URL(url).hostname} answered ${res.status}`, 502);
  return res.json();
}

// Streams a file to disk with a size cap and (optionally) a hash check. Only fixed hosts are allowed, including after redirects.
async function download(fetchImpl, url, dest, { hosts, headers = {}, sha512, sha1 }) {
  if (!hosts.includes(new URL(url).hostname)) throw new McError("Refusing to download from that host");
  let res;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": UA, ...headers }, redirect: "follow", signal: AbortSignal.timeout(120_000) });
  } catch (e) {
    throw new McError(`Download failed: ${e.message}`, 502);
  }
  if (!res.ok || !res.body) throw new McError(`Download failed (${res.status})`, 502);
  const finalHost = res.url ? new URL(res.url).hostname : new URL(url).hostname;
  if (!hosts.includes(finalHost)) throw new McError(`The download went to ${finalHost}, which isn't allowed`);
  const tmp = `${dest}.part`;
  const h512 = createHash("sha512");
  const h1 = createHash("sha1");
  let size = 0;
  const meter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > MAX_BYTES) return cb(new McError("That file is bigger than 150 MB, which isn't a plugin"));
      h512.update(chunk);
      h1.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(tmp, { flags: "wx" }));
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e instanceof McError ? e : new McError(`Download failed: ${e.message}`, 502);
  }
  if ((sha512 && h512.digest("hex") !== sha512.toLowerCase()) || (sha1 && !sha512 && h1.digest("hex") !== sha1.toLowerCase())) {
    await fs.rm(tmp, { force: true });
    throw new McError("The download didn't match its published checksum, so it was thrown away");
  }
  if (size < 1000) {
    await fs.rm(tmp, { force: true });
    throw new McError("The download was too small to be a plugin");
  }
  await fs.rename(tmp, dest);
  return size;
}

export function createPlugins({ fetchImpl, getToken = () => "", getMeta = () => null }) {
  const dirOf = (root, kind) => path.join(root, kind);

  async function list(root, kind) {
    const dir = dirOf(root, kind);
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of await fs.readdir(dir)) {
      if (!JAR.test(name)) continue;
      const st = await fs.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ file: name, enabled: !name.endsWith(".disabled"), size: st.size, modified: Math.floor(st.mtimeMs) });
    }
    return out.sort((a, b) => a.file.localeCompare(b.file, undefined, { sensitivity: "base" }));
  }

  function checkName(file) {
    if (typeof file !== "string" || !JAR.test(file) || file.includes("/") || file.includes("..")) throw new McError("Bad file name");
    return file;
  }

  async function setEnabled(root, kind, file, enabled) {
    checkName(file);
    const dir = dirOf(root, kind);
    const from = path.join(dir, file);
    if (!existsSync(from)) throw new McError("That file isn't there anymore", 404);
    const to = path.join(dir, enabled ? file.replace(/\.disabled$/, "") : file.endsWith(".disabled") ? file : `${file}.disabled`);
    if (to === from) return { file };
    if (existsSync(to)) throw new McError("A file with that name already exists");
    await fs.rename(from, to);
    return { file: path.basename(to) };
  }

  async function remove(root, kind, file) {
    checkName(file);
    const p = path.join(dirOf(root, kind), file);
    if (!existsSync(p)) throw new McError("That file isn't there anymore", 404);
    await fs.rm(p);
  }

  // ---- Modrinth -----------------------------------------------------------------------
  const loadersFor = (kind, meta) => {
    const f = meta?.flavor;
    if (kind === "mods") return ["fabric"];
    if (f === "purpur") return ["purpur", "paper", "spigot", "bukkit"];
    return ["paper", "spigot", "bukkit"];
  };
  const gameVersion = (meta, given) => {
    const v = given || meta?.version;
    return v && /^\d+(\.\d+){1,3}$/.test(v) ? v : null;
  };

  async function modrinthSearch({ kind, id, q, version }) {
    const meta = getMeta(id);
    const gv = gameVersion(meta, version);
    const facets = [[`project_type:${kind === "mods" ? "mod" : "plugin"}`], loadersFor(kind, meta).map((l) => `categories:${l}`)];
    if (gv) facets.push([`versions:${gv}`]);
    const url = `https://api.modrinth.com/v2/search?query=${encodeURIComponent(String(q ?? "").slice(0, 80))}&limit=20&index=downloads&facets=${encodeURIComponent(JSON.stringify(facets))}`;
    const r = await getJson(fetchImpl, url);
    return { gameVersion: gv, hits: (r.hits ?? []).map((h) => ({ slug: h.slug, title: h.title, description: h.description, downloads: h.downloads, author: h.author })) };
  }

  async function modrinthInstall({ root, kind, id, slug, version }) {
    if (!/^[A-Za-z0-9_-]{2,64}$/.test(String(slug))) throw new McError("Bad project");
    const meta = getMeta(id);
    const gv = gameVersion(meta, version);
    const q = new URLSearchParams({ loaders: JSON.stringify(loadersFor(kind, meta)) });
    if (gv) q.set("game_versions", JSON.stringify([gv]));
    const versions = await getJson(fetchImpl, `https://api.modrinth.com/v2/project/${slug}/version?${q}`);
    const v = versions.find((x) => x.version_type === "release") ?? versions[0];
    if (!v) throw new McError(`No ${gv ? `build for Minecraft ${gv}` : "compatible build"} of that project`);
    const file = v.files.find((f) => f.primary) ?? v.files[0];
    if (!file?.url) throw new McError("That version has no downloadable file");
    const name = safeJarName(file.filename);
    const dir = dirOf(root, kind);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, name);
    if (existsSync(dest)) throw new McError(`${name} is already installed`);
    const size = await download(fetchImpl, file.url, dest, { hosts: MODRINTH_HOSTS, sha512: file.hashes?.sha512, sha1: file.hashes?.sha1 });
    const deps = (v.dependencies ?? []).filter((d) => d.dependency_type === "required" && /^[A-Za-z0-9]{6,12}$/.test(String(d.project_id))).map((d) => d.project_id);
    return { file: name, size, version: v.version_number, deps };
  }

  // ---- the curated catalog ----
  const cache = new Map(); // `${kind}|${gv}` -> { at, list }
  async function catalog({ kind, id, version }) {
    const meta = getMeta(id);
    const gv = gameVersion(meta, version);
    const key = `${kind}|${gv}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;
    const slugs = [...catalogSlugs()];
    const ids = encodeURIComponent(JSON.stringify(slugs));
    const projects = await getJson(fetchImpl, `https://api.modrinth.com/v2/projects?ids=${ids}`);
    const loaders = loadersFor(kind, meta);
    const ok = new Map(projects.filter((p) => p.project_type === (kind === "mods" ? "mod" : "plugin") && (p.loaders ?? []).some((l) => loaders.includes(l)) && (!gv || (p.game_versions ?? []).includes(gv))).map((p) => [p.slug, p]));
    const items = CATALOG.map((c) => {
      const slug = [c.slug, ...(c.alt ?? [])].find((x) => ok.has(x));
      return slug ? { ...c, slug, alt: undefined, downloads: ok.get(slug).downloads } : null;
    }).filter(Boolean);
    const live = (want) => items.find((i) => i.slug === want || CATALOG.find((c) => c.slug === want)?.alt?.includes(i.slug))?.slug;
    const bundles = BUNDLES.map((b) => ({ ...b, slugs: b.slugs.map(live).filter(Boolean) })).filter((b) => b.slugs.length >= 2);
    const data = { gameVersion: gv, kind, categories: CATEGORIES.filter((c) => items.some((i) => i.category === c.id)), items: items.map(({ alt, ...i }) => i), bundles, unavailable: CATALOG.length - items.length };
    cache.set(key, { at: Date.now(), data });
    return data;
  }

  // Installs the chosen catalog plugins plus whatever they list as required, skipping what's already there.
  async function installMany({ root, kind, id, slugs, version }) {
    const allowed = catalogSlugs();
    const queue = [...new Set(slugs)].filter((x) => allowed.has(x));
    if (!queue.length) throw new McError("Pick something from the list");
    const results = [];
    const seen = new Set();
    while (queue.length && results.length < 25) {
      const slug = queue.shift();
      if (seen.has(slug)) continue;
      seen.add(slug);
      try {
        const r = await modrinthInstall({ root, kind, id, slug, version });
        results.push({ slug, ok: true, file: r.file, version: r.version });
        for (const pid of r.deps) {
          try {
            const p = await getJson(fetchImpl, `https://api.modrinth.com/v2/project/${pid}`);
            if (p.slug && !seen.has(p.slug)) queue.push(p.slug);
          } catch { /* a dependency we can't look up is reported by the plugin itself at startup */ }
        }
      } catch (e) {
        const already = /already installed/.test(e.message);
        results.push({ slug, ok: already, skipped: already, error: already ? undefined : e.message });
      }
    }
    return { results };
  }

  // ---- GitHub (bring your own token) ---------------------------------------------------
  const ghHeaders = () => {
    const t = getToken();
    return { "x-github-api-version": "2022-11-28", ...(t ? { authorization: `Bearer ${t}` } : {}) };
  };
  const seg = (s) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(String(s ?? ""))) throw new McError("That isn't a valid GitHub user or organization name");
    return s;
  };

  async function githubRepos(owner) {
    seg(owner);
    const fetchPage = (kind) => getJson(fetchImpl, `https://api.github.com/${kind}/${owner}/repos?per_page=100&sort=updated`, ghHeaders());
    let repos;
    try {
      repos = await fetchPage("orgs");
    } catch (e) {
      if (e.status !== 404) throw e;
      repos = await fetchPage("users");
    }
    return repos.filter((r) => !r.archived).map((r) => ({ name: r.name, full: r.full_name, description: r.description, private: r.private }));
  }

  async function githubReleases(repoInput) {
    let repo;
    try { repo = parseRepo(repoInput); } catch (e) { if (e instanceof RepoError) throw new McError(e.message); throw e; }
    if (repo.host !== "github.com") throw new McError("Only github.com is supported here");
    const r = await getJson(fetchImpl, `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases/latest`, ghHeaders());
    const assets = (r.assets ?? []).filter((a) => /\.jar$/i.test(a.name)).map((a) => ({ id: a.id, name: a.name, size: a.size, likely: !/(sources|javadoc|dev|api)\b/i.test(a.name) }));
    return { repo: repo.slug, tag: r.tag_name, assets };
  }

  async function githubInstall({ root, kind, repo: repoInput, assetId }) {
    const rel = await githubReleases(repoInput);
    const asset = rel.assets.find((a) => String(a.id) === String(assetId));
    if (!asset) throw new McError("That file isn't in the latest release");
    const [owner, name] = rel.repo.split("/");
    const safe = safeJarName(asset.name);
    const dir = dirOf(root, kind);
    await fs.mkdir(dir, { recursive: true });
    const dest = path.join(dir, safe);
    if (existsSync(dest)) throw new McError(`${safe} is already installed`);
    // The token goes to api.github.com only; the redirect to the file host carries no credentials.
    const size = await download(fetchImpl, `https://api.github.com/repos/${owner}/${name}/releases/assets/${asset.id}`, dest, {
      hosts: [...GH_ASSET_HOSTS, "api.github.com"],
      headers: { ...ghHeaders(), accept: "application/octet-stream" },
    });
    return { file: safe, size, tag: rel.tag };
  }

  return { list, setEnabled, remove, modrinthSearch, modrinthInstall, catalog, installMany, githubRepos, githubReleases, githubInstall };
}
