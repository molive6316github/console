import { createWriteStream, existsSync, readFileSync, readdirSync, promises as fs } from "node:fs";
import path from "node:path";
import net from "node:net";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";
import { McError, parse, apply } from "./props.js";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
export const WORLD_NAME = /^[A-Za-z0-9._-]{1,48}$/;
// Folders in a server that are never a world, whatever they contain.
const RESERVED = new Set(["plugins", "mods", "logs", "config", "cache", "versions", "libraries", "old-worlds", "crash-reports", "backups", "world-backups", "defaultconfigs", "datapacks", "resourcepacks", "bundler", "node_modules"]);
export const MAX_UNPACKED = 12 * 1024 ** 3; // a zip bomb can't fill the disk
export const MAX_ENTRIES = 400_000;
export const MAX_DOWNLOAD = 4 * 1024 ** 3;

const looksLikeWorld = (dir) =>
  ["level.dat", "region", "DIM-1", "DIM1", "dimensions"].some((n) => existsSync(path.join(dir, n)));

function levelName(root) {
  try {
    return parse(readFileSync(path.join(root, "server.properties"), "utf8")).values["level-name"] || "world";
  } catch { return "world"; }
}

async function dirSize(dir, budget = { files: 300_000 }) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.files-- <= 0) return total;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p, budget);
    else if (e.isFile()) total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

// Every world folder in the server. The _nether and _the_end folders are shown as part of their world.
export async function listWorlds(root) {
  const main = levelName(root);
  const names = [];
  for (const e of await fs.readdir(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith(".") || RESERVED.has(e.name) || !WORLD_NAME.test(e.name)) continue;
    if (looksLikeWorld(path.join(root, e.name))) names.push(e.name);
  }
  const set = new Set(names);
  const dimOf = (n) => (n.endsWith("_nether") && set.has(n.slice(0, -7)) ? n.slice(0, -7) : n.endsWith("_the_end") && set.has(n.slice(0, -8)) ? n.slice(0, -8) : null);
  const out = [];
  for (const n of names.sort()) {
    if (dimOf(n)) continue;
    const dims = [`${n}_nether`, `${n}_the_end`].filter((d) => set.has(d));
    const size = (await dirSize(path.join(root, n))) + (await Promise.all(dims.map((d) => dirSize(path.join(root, d))))).reduce((a, b) => a + b, 0);
    out.push({ name: n, main: n === main, dims, size });
  }
  return { main, worlds: out };
}

export function multiverseInfo(root) {
  let jar = null;
  try {
    jar = (existsSync(path.join(root, "plugins")) ? readdirSync(path.join(root, "plugins")) : []).find((f) => /^multiverse-core.*\.jar$/i.test(f)) ?? null;
  } catch { /* none */ }
  const version = jar ? (/(\d+)\.(\d+)/.exec(jar)?.[0] ?? null) : null;
  const major = version ? Number(version.split(".")[0]) : null;
  return { installed: Boolean(jar), version, major };
}

// ---- zip reading (safe) ----
function openZip(file) {
  return new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false }, (e, z) => (e ? reject(new McError("That isn't a readable zip file")) : resolve(z))));
}
function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const all = [];
    zip.on("entry", (en) => {
      if (all.length >= MAX_ENTRIES) return reject(new McError("That zip has too many files"));
      all.push(en);
      zip.readEntry();
    });
    zip.on("end", () => resolve(all));
    zip.on("error", (e) => reject(new McError(`That zip is damaged: ${e.message}`)));
    zip.readEntry();
  });
}
const isLink = (en) => (((en.externalFileAttributes >>> 16) & 0o170000) === 0o120000);
const unsafeName = (n) => n.startsWith("/") || /^[A-Za-z]:/.test(n) || n.split("/").includes("..") || n.includes("\0") || n.includes("\\");

// Where the world starts inside the zip: the shallowest folder holding level.dat.
function worldPrefix(names) {
  const hits = names.filter((n) => /(^|\/)level\.dat$/.test(n) && !n.startsWith("__MACOSX/"));
  if (!hits.length) return null;
  hits.sort((a, b) => a.split("/").length - b.split("/").length);
  return hits[0].slice(0, hits[0].length - "level.dat".length);
}

// Unpacks a zip into <root>/<name>. Refuses unsafe paths, links, huge archives, and anything that isn't a world.
export async function importZip({ root, file, name, maxBytes = MAX_UNPACKED }) {
  if (!WORLD_NAME.test(String(name ?? "")) || name.startsWith(".")) throw new McError("World names can use letters, numbers, dot, dash and underscore (up to 48)");
  if (RESERVED.has(name)) throw new McError(`"${name}" is a reserved folder name. Pick another`);
  const dest = path.join(root, name);
  if (existsSync(dest)) throw new McError(`There's already a world called ${name}. Pick another name`, 409);
  const zip = await openZip(file);
  const tmp = path.join(root, `.import-${stamp()}-${Math.random().toString(36).slice(2, 6)}`);
  try {
    const entries = await listEntries(zip);
    for (const en of entries) {
      if (unsafeName(en.fileName)) throw new McError("That zip contains unsafe paths, so it wasn't imported");
      if (isLink(en)) throw new McError("That zip contains symbolic links, so it wasn't imported");
    }
    const prefix = worldPrefix(entries.map((e) => e.fileName));
    if (prefix === null) throw new McError("That zip doesn't look like a Minecraft world (no level.dat inside)");
    const declared = entries.reduce((s, e) => s + e.uncompressedSize, 0);
    if (declared > maxBytes) throw new McError("That world is too large to unpack");
    await fs.mkdir(tmp, { mode: 0o755 });
    let written = 0;
    for (const en of entries) {
      if (!en.fileName.startsWith(prefix) || en.fileName.startsWith("__MACOSX/")) continue;
      const rel = en.fileName.slice(prefix.length);
      if (!rel || rel === "uid.dat") continue; // uid.dat is dropped so Multiverse gives the copy its own id
      const target = path.join(tmp, rel);
      if (!target.startsWith(tmp + path.sep)) throw new McError("That zip contains unsafe paths, so it wasn't imported");
      if (en.fileName.endsWith("/")) { await fs.mkdir(target, { recursive: true }); continue; }
      await fs.mkdir(path.dirname(target), { recursive: true });
      const stream = await new Promise((res, rej) => zip.openReadStream(en, (e, s) => (e ? rej(e) : res(s))));
      const cap = new Transform({ transform(chunk, _e, cb) { written += chunk.length; cb(written > maxBytes ? new McError("That world is larger than it said it was, so it wasn't imported") : null, chunk); } });
      await pipeline(stream, cap, createWriteStream(target, { mode: 0o644 }));
    }
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw e;
  } finally {
    zip.close();
  }
  return { name, ...(await listWorlds(root)).worlds.find((w) => w.name === name) };
}

// ---- zip writing ----
async function addDir(zipfile, dir, base) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.name === "session.lock") continue;
    const p = path.join(dir, e.name);
    const rel = `${base}/${e.name}`;
    if (e.isDirectory()) await addDir(zipfile, p, rel);
    else if (e.isFile()) zipfile.addFile(p, rel);
  }
}

// A zip of the world (plus its nether/end folders) as a readable stream. Layout: <name>/level.dat ...
export async function exportZip({ root, name }) {
  const { worlds } = await listWorlds(root);
  const w = worlds.find((x) => x.name === name);
  if (!w) throw new McError("No such world", 404);
  const zipfile = new yazl.ZipFile();
  for (const d of [w.name, ...w.dims]) await addDir(zipfile, path.join(root, d), d);
  zipfile.end();
  return { stream: zipfile.outputStream, filename: `${name}.zip` };
}

// ---- download from a link (SSRF-safe) ----
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === "::" || v === "::1") return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (m) return isPrivateAddress(m[1]);
    return v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
  }
  return true;
}

// Resolves the host once, refuses private addresses, and connects to exactly that address (no DNS rebinding).
async function pinned(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new McError("That isn't a valid link"); }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new McError("Links must start with http:// or https://");
  if (u.username || u.password) throw new McError("Links with a login in them aren't supported");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [{ address: host, family: net.isIP(host) }] : await dns.lookup(host, { all: true }).catch(() => { throw new McError(`Couldn't find ${host}`, 502); });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new McError("That link points at a private address on this network, so it was refused");
  return { u, addr: addrs[0] };
}

export async function httpGet(urlStr, { maxBytes = MAX_DOWNLOAD, timeoutMs = 30 * 60_000, hops = 4 } = {}) {
  for (let i = 0; i <= hops; i++) {
    const { u, addr } = await pinned(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const res = await new Promise((resolve, reject) => {
      const req = mod.request(u, { method: "GET", headers: { "user-agent": "console-world-import", accept: "*/*" }, lookup: (_h, _o, cb) => cb(null, addr.address, addr.family), timeout: 30_000 }, resolve);
      req.on("timeout", () => req.destroy(new Error("timed out")));
      req.on("error", reject);
      req.end();
    }).catch((e) => { throw new McError(`Couldn't download that: ${e.message}`, 502); });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      urlStr = new URL(res.headers.location, u).toString();
      continue;
    }
    if (res.statusCode !== 200) { res.resume(); throw new McError(`That link answered ${res.statusCode}`, 502); }
    if (Number(res.headers["content-length"] ?? 0) > maxBytes) { res.destroy(); throw new McError("That file is too big"); }
    const limit = new Transform({ transform(c, _e, cb) { this.n = (this.n ?? 0) + c.length; cb(this.n > maxBytes ? new McError("That file is too big") : null, c); } });
    const t = setTimeout(() => res.destroy(new Error("took too long")), timeoutMs);
    res.on("close", () => clearTimeout(t));
    return res.pipe(limit);
  }
  throw new McError("That link redirects too many times");
}

export async function importFromUrl({ root, url, name, tmpDir, get = httpGet }) {
  await fs.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `import-${stamp()}-${Math.random().toString(36).slice(2, 6)}.zip`);
  try {
    const stream = await get(url);
    await pipeline(stream, createWriteStream(file, { mode: 0o600 }));
    return await importZip({ root, file, name });
  } finally {
    await fs.rm(file, { force: true });
  }
}

// Saves a request body (the upload) to a file with a size cap.
export async function saveUpload({ stream, tmpDir, maxBytes = MAX_DOWNLOAD }) {
  await fs.mkdir(tmpDir, { recursive: true });
  const file = path.join(tmpDir, `upload-${stamp()}-${Math.random().toString(36).slice(2, 6)}.zip`);
  const cap = new Transform({ transform(c, _e, cb) { this.n = (this.n ?? 0) + c.length; cb(this.n > maxBytes ? new McError("That file is too big", 413) : null, c); } });
  try {
    await pipeline(stream, cap, createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    await fs.rm(file, { force: true });
    throw e instanceof McError ? e : new McError(`The upload didn't finish: ${e.message}`, 400);
  }
  return file;
}

// ---- changing worlds (server must be stopped) ----
function mustBeWorld(list, name) {
  if (!WORLD_NAME.test(String(name ?? ""))) throw new McError("Bad world name");
  const w = list.worlds.find((x) => x.name === name);
  if (!w) throw new McError("No such world", 404);
  return w;
}

// Moves a world into old-worlds/<time>/ (nothing is deleted). The main world can't be removed.
export async function archiveWorld({ root, name }) {
  const list = await listWorlds(root);
  const w = mustBeWorld(list, name);
  if (w.main) throw new McError("That's the main world. Make another world the main one first");
  const dest = path.join(root, "old-worlds", stamp());
  await fs.mkdir(dest, { recursive: true });
  for (const d of [w.name, ...w.dims]) await fs.rename(path.join(root, d), path.join(dest, d));
  return { movedTo: path.relative(root, dest) };
}

// Makes a world the one new players start in (level-name in server.properties). Takes effect on next start.
export async function setMainWorld({ root, name }) {
  const list = await listWorlds(root);
  const w = mustBeWorld(list, name);
  const file = path.join(root, "server.properties");
  const text = await fs.readFile(file, "utf8");
  await fs.writeFile(file, apply(text, { "level-name": w.name }).text);
  return { main: w.name, previous: list.main };
}

// ---- Multiverse ----
export function envOf(name, hint) {
  if (["normal", "nether", "the_end"].includes(hint)) return hint;
  return /_nether$/.test(name) ? "nether" : /_the_end$/.test(name) ? "the_end" : "normal";
}

const LOBBY = /^[A-Za-z0-9._-]{1,48}$/;
// The commands that turn a world into a lobby, for the Multiverse version that's installed. Shown to the person before anything runs.
export function lobbyPlan({ name = "lobby", exists, mv }) {
  if (!LOBBY.test(name)) throw new McError("Lobby names can use letters, numbers, dot, dash and underscore");
  const v5 = (mv?.major ?? 5) >= 5;
  const set = (prop, val) => (v5 ? `mv modify ${name} set ${prop} ${val}` : `mv modify set ${prop} ${val} ${name}`);
  const rule = (r, val) => (v5 ? `mv gamerule ${name} set ${r} ${val}` : `mv gamerule set ${r} ${val} ${name}`);
  return [
    { label: exists ? "Load the world into Multiverse" : "Create a flat void-free lobby world", cmd: exists ? `mv import ${name} normal` : `mv create ${name} normal -t flat` },
    { label: "Peaceful, no PvP", cmd: set("difficulty", "peaceful") },
    { label: "Turn PvP off", cmd: set("pvp", "false") },
    { label: "No monsters", cmd: set("monsters", "false") },
    { label: "Everyone in adventure mode (can't break the build)", cmd: set("gamemode", "adventure") },
    { label: "Freeze the clock", cmd: rule("doDaylightCycle", "false") },
    { label: "Always daytime", cmd: "time set day" },
  ].map((s, i) => ({ ...s, id: i + 1 }));
}

export const SAFE_COMMAND = /^(mv|mvm|difficulty|gamerule|time|weather|setworldspawn|worldborder) [A-Za-z0-9 ._:=,\-]{1,180}$/;

// Lines in `after` that weren't in `before` (the logs are a sliding window).
export function newLines(before, after) {
  const b = String(before).split("\n").filter(Boolean);
  const a = String(after).split("\n").filter(Boolean);
  for (let k = Math.min(b.length, a.length); k > 0; k--) {
    if (b.slice(b.length - k).join("\n") === a.slice(0, k).join("\n")) return a.slice(k);
  }
  return a;
}
