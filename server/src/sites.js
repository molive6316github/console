import path from "node:path";
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { getSetting, setSetting } from "./db.js";
import { validHost } from "./dns.js";

export class SiteError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

const TYPES = { html: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", txt: "text/plain; charset=utf-8", md: "text/plain; charset=utf-8", svg: "image/svg+xml", ico: "image/x-icon", png: "image/png", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };
const EDITABLE = /\.(html|css|js|json|txt|md|svg)$/i;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const MAX_FILE = 200 * 1024;
const MAX_FILES = 40;
const HEX = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_CONFIG = {
  title: "My Minecraft Server",
  tagline: "Survival, friends, and good vibes.",
  ip: "",
  accent: "#4ade80",
  discord: "",
  storeUrl: "",
  products: [],
};

// The page is plain files. site.js reads site.json, so editing the form never touches the HTML.
const CSS = `:root{--accent:#4ade80;--bg:#0e1116;--card:#181d25;--text:#e8ecf1;--dim:#8b95a5}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--bg);color:var(--text)}
.wrap{max-width:960px;margin:0 auto;padding:0 20px}
.hero{padding:88px 0 56px;text-align:center}
h1{font-size:clamp(34px,7vw,64px);margin:0 0 12px;letter-spacing:-.02em}
.tag{color:var(--dim);font-size:19px;margin:0 0 28px}
.ip{display:inline-flex;gap:10px;align-items:center;background:var(--card);border:1px solid #2a323d;border-radius:12px;padding:12px 18px;font:600 18px ui-monospace,monospace;cursor:pointer;color:var(--text)}
.ip small{font:13px system-ui;color:var(--accent)}
.status{margin-top:18px;color:var(--dim);font-size:15px}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#555;margin-right:7px}
.dot.on{background:var(--accent)}.dot.off{background:#e5534b}
.links{margin-top:26px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap}
.btn{display:inline-block;padding:11px 20px;border-radius:10px;background:var(--accent);color:#06210f;font-weight:700;text-decoration:none}
.btn.ghost{background:transparent;color:var(--text);border:1px solid #2a323d}
h2{font-size:28px;margin:48px 0 18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px;padding-bottom:64px}
.card{background:var(--card);border:1px solid #2a323d;border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:8px}
.card h3{margin:0;font-size:19px}.card p{margin:0;color:var(--dim);flex:1}
.price{font-weight:800;font-size:22px;color:var(--accent)}
footer{border-top:1px solid #1d232c;padding:24px 0;text-align:center;color:var(--dim);font-size:14px}
[hidden]{display:none!important}`;

const JS = `fetch("site.json?"+Date.now()).then(r=>r.json()).then(c=>{
  const $=id=>document.getElementById(id);
  document.title=c.title||"Server";
  $("title").textContent=c.title||"";$("tagline").textContent=c.tagline||"";
  if(/^#[0-9a-fA-F]{6}$/.test(c.accent||""))document.documentElement.style.setProperty("--accent",c.accent);
  if(c.ip){$("ipbox").hidden=false;$("ip").textContent=c.ip;
    $("ipbox").onclick=()=>{navigator.clipboard&&navigator.clipboard.writeText(c.ip);$("copied").textContent="copied!";setTimeout(()=>$("copied").textContent="click to copy",1500)}}
  const link=(id,u)=>{const a=$(id);if(/^https?:\\/\\//.test(u||"")){a.href=u;a.hidden=false}};
  link("discord",c.discord);link("store",c.storeUrl);
  const ps=Array.isArray(c.products)?c.products:[];
  if(ps.length){$("shop").hidden=false;const g=$("grid");
    for(const p of ps){const d=document.createElement("div");d.className="card";
      const h=document.createElement("h3");h.textContent=p.name||"";
      const t=document.createElement("p");t.textContent=p.desc||"";
      const pr=document.createElement("div");pr.className="price";pr.textContent=p.price||"";
      d.append(h,t,pr);
      if(/^https?:\\/\\//.test(p.url||"")){const a=document.createElement("a");a.className="btn";a.textContent="Buy";a.href=p.url;a.rel="noopener";d.append(a)}
      g.append(d)}}
}).catch(()=>{});
fetch("_status.json").then(r=>r.json()).then(s=>{
  const el=$("status");if(!s||!s.enabled){return}
  el.hidden=false;
  const dot=document.createElement("span");dot.className="dot "+(s.online?"on":"off");
  el.append(dot,document.createTextNode(s.online?(s.players.online+" / "+s.players.max+" players online"):"Server is offline"));
}).catch(()=>{});
function $(id){return document.getElementById(id)}`;

const HTML = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/[<>&]/g, "")}</title><link rel="stylesheet" href="style.css"></head>
<body>
<header class="hero"><div class="wrap">
  <h1 id="title"></h1><p class="tag" id="tagline"></p>
  <div class="ip" id="ipbox" hidden><span id="ip"></span><small id="copied">click to copy</small></div>
  <div class="status" id="status" hidden></div>
  <div class="links"><a class="btn" id="store" hidden>Store</a><a class="btn ghost" id="discord" hidden>Discord</a></div>
</div></header>
<main class="wrap"><section id="shop" hidden><h2>Store</h2><div class="grid" id="grid"></div></section></main>
<footer>Not affiliated with Mojang or Microsoft.</footer>
<script src="site.js"></script></body></html>`;

const BLANK = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hello</title></head>
<body><h1>Hello!</h1><p>Edit this page in Console → Website.</p></body></html>`;

export const TEMPLATES = {
  landing: { label: "Server page", blurb: "Big name, copy-able IP, live player count, Discord button." },
  store: { label: "Server page + store", blurb: "Same, plus product cards (ranks, crates) that link to your checkout." },
  blank: { label: "Blank", blurb: "One empty page. Edit the HTML yourself." },
};

export function templateFiles(kind, config) {
  if (kind === "blank") return { "index.html": BLANK };
  return { "index.html": HTML(config.title), "style.css": CSS, "site.js": JS, "site.json": JSON.stringify(config, null, 2) + "\n" };
}

export function cleanConfig(input, base = DEFAULT_CONFIG) {
  const s = (v, max) => String(v ?? "").slice(0, max);
  const url = (v) => { const x = s(v, 300).trim(); if (x && !/^https?:\/\/[^\s]+$/.test(x)) throw new SiteError(`"${x}" should start with http:// or https://`); return x; };
  const b = { ...base, ...input };
  if (b.accent && !HEX.test(b.accent)) throw new SiteError("Colour must look like #4ade80");
  const products = (Array.isArray(b.products) ? b.products : []).slice(0, 24).map((p) => ({ name: s(p?.name, 60), price: s(p?.price, 20), desc: s(p?.desc, 200), url: url(p?.url) })).filter((p) => p.name);
  return { title: s(b.title, 80).trim() || DEFAULT_CONFIG.title, tagline: s(b.tagline, 200), ip: s(b.ip, 120).trim(), accent: b.accent || DEFAULT_CONFIG.accent, discord: url(b.discord), storeUrl: url(b.storeUrl), products };
}

export function createSites({ db, dataDir, run, caddy = {}, port = 3000, publicStatus, now = () => Date.now() }) {
  const root = path.join(dataDir, "sites");
  const read = () => { try { const x = JSON.parse(getSetting(db, "sites", "[]")); return Array.isArray(x) ? x : []; } catch { return []; } };
  const save = (list) => setSetting(db, "sites", JSON.stringify(list));
  const find = (host) => read().find((s) => s.host === String(host).toLowerCase());
  const dirOf = (host) => path.join(root, host);

  let hostCache = { at: 0, set: new Set() };
  const isSiteHost = (h) => {
    if (now() - hostCache.at > 3000) hostCache = { at: now(), set: new Set(read().filter((s) => s.template).map((s) => s.host)) };
    return hostCache.set.has(h);
  };

  async function route(host) {
    const file = path.join(caddy.sitesDir ?? "", `${host}.caddy`);
    const snippet = `${host} {\n    encode gzip\n    reverse_proxy 127.0.0.1:${port}\n}\n`;
    if (!caddy.sitesDir) return { routed: false, snippet };
    try {
      await stat(caddy.sitesDir);
      await writeFile(file, `# Managed by Console (Website page)\n${snippet}`);
    } catch { return { routed: false, snippet }; }
    const v = await run("sudo", ["-n", "caddy", "validate", "--adapter", "caddyfile", "--config", caddy.caddyfile ?? "/etc/caddy/Caddyfile"], { timeout: 30_000 });
    if (v.code !== 0) { await rm(file, { force: true }); return { routed: false, snippet, error: "Caddy didn't accept the new site, so nothing was changed." }; }
    const r = await run("sudo", ["-n", "systemctl", "reload", "caddy"], { timeout: 30_000 });
    if (r.code !== 0) return { routed: false, snippet, error: "The site file is written but Caddy couldn't reload (Console needs passwordless sudo for that)." };
    return { routed: true, snippet };
  }

  async function list() {
    return Promise.all(read().map(async (s) => ({ ...s, files: s.template ? await files(s.host).catch(() => []) : [] })));
  }

  async function create({ host, template = "landing", ip = "" }) {
    host = String(host ?? "").trim().toLowerCase();
    if (!validHost(host)) throw new SiteError(`"${host}" doesn't look like a domain name (try shop.yourdomain.com)`);
    if (!TEMPLATES[template]) throw new SiteError("Unknown template");
    if (find(host)?.template) throw new SiteError("That address already has a website");
    if (host === String(getSetting(db, "join_domain", "")).toLowerCase()) { /* same name as the join address is fine: the site is HTTP, the game is TCP */ }
    const config = cleanConfig({ ip });
    await mkdir(dirOf(host), { recursive: true });
    for (const [name, body] of Object.entries(templateFiles(template, config))) await writeFile(path.join(dirOf(host), name), body);
    const list = read().filter((s) => s.host !== host);
    list.push({ host, role: "Website", template });
    save(list);
    hostCache.at = 0;
    return { host, template, ...(await route(host)) };
  }

  async function remove(host) {
    host = String(host).toLowerCase();
    if (!find(host)) throw new SiteError("No such website", 404);
    save(read().filter((s) => s.host !== host));
    hostCache.at = 0;
    await rm(dirOf(host), { recursive: true, force: true });
    if (caddy.sitesDir) {
      await rm(path.join(caddy.sitesDir, `${host}.caddy`), { force: true });
      await run("sudo", ["-n", "systemctl", "reload", "caddy"], { timeout: 30_000 });
    }
    return { ok: true };
  }

  async function files(host) {
    if (!find(host)) throw new SiteError("No such website", 404);
    const names = await readdir(dirOf(host));
    return names.filter((n) => FILE_NAME.test(n)).sort();
  }
  const fileOk = (host, name) => {
    if (!find(host)) throw new SiteError("No such website", 404);
    if (!FILE_NAME.test(name) || !EDITABLE.test(name)) throw new SiteError("Only .html .css .js .json .txt .md .svg files with simple names can be edited here");
    return path.join(dirOf(host), name);
  };
  async function readFileText(host, name) {
    try { return await readFile(fileOk(host, name), "utf8"); } catch (e) { if (e.code === "ENOENT") throw new SiteError("No such file", 404); throw e; }
  }
  async function writeFileText(host, name, text) {
    const p = fileOk(host, name);
    if (typeof text !== "string" || Buffer.byteLength(text) > MAX_FILE) throw new SiteError("File is too big (200 KB max)");
    if ((await files(host)).length >= MAX_FILES && !(await files(host)).includes(name)) throw new SiteError("Too many files in one site");
    await writeFile(p, text);
  }
  async function deleteFile(host, name) {
    const p = fileOk(host, name);
    if (name === "index.html") throw new SiteError("index.html is the front page; edit it instead");
    await rm(p, { force: true });
  }

  async function getConfig(host) {
    try { return cleanConfig(JSON.parse(await readFileText(host, "site.json"))); } catch (e) { if (e instanceof SiteError && e.status === 404) return null; return DEFAULT_CONFIG; }
  }
  async function putConfig(host, input) {
    const cur = (await getConfig(host)) ?? DEFAULT_CONFIG;
    const next = cleanConfig(input, cur);
    await writeFile(fileOk(host, "site.json"), JSON.stringify(next, null, 2) + "\n");
    return next;
  }

  // Called for every request whose Host matches a site. Returns true when it answered.
  async function serve(req, reply) {
    const host = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!isSiteHost(host)) return false;
    reply.header("Content-Security-Policy", "default-src 'self'; img-src * data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (req.method !== "GET" && req.method !== "HEAD") { reply.code(405).send("Method not allowed"); return true; }
    let rel;
    try { rel = decodeURIComponent(req.url.split("?")[0]); } catch { reply.code(400).send("Bad request"); return true; }
    if (rel === "/_status.json") {
      reply.header("Cache-Control", "no-store").type(TYPES.json);
      reply.send(JSON.stringify(await (publicStatus?.() ?? { enabled: false })));
      return true;
    }
    if (rel.endsWith("/")) rel += "index.html";
    const name = rel.replace(/^\//, "");
    if (!FILE_NAME.test(name)) { reply.code(404).type(TYPES.txt).send("Not found"); return true; }
    try {
      const body = await readFile(path.join(dirOf(host), name));
      const ext = name.split(".").pop().toLowerCase();
      reply.header("Cache-Control", "no-cache").type(TYPES[ext] ?? "application/octet-stream").send(body);
    } catch {
      reply.code(404).type(TYPES.txt).send("Not found");
    }
    return true;
  }

  return { list, create, remove, files, readFile: readFileText, writeFile: writeFileText, deleteFile, getConfig, putConfig, serve, route, TEMPLATES };
}
