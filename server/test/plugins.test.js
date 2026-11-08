import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { safeJarName } from "../src/mc/plugins.js";

const JAR = Buffer.alloc(5000, 7);
const sha512 = createHash("sha512").update(JAR).digest("hex");
const jsonRes = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const withUrl = (r, url) => (Object.defineProperty(r, "url", { value: url }), r);

function setup({ safeMode = false, badHash = false, redirectTo } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-plug-"));
  const dir = path.join(base, "mc");
  mkdirSync(path.join(dir, "plugins"), { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=x\n");
  writeFileSync(path.join(dir, "plugins", "EssentialsX.jar"), JAR);
  writeFileSync(path.join(dir, "plugins", "Old.jar.disabled"), JAR);
  writeFileSync(path.join(dir, "plugins", "notes.txt"), "x");
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    seen.push({ url, auth: opts.headers?.authorization });
    if (u.hostname === "api.modrinth.com" && u.pathname === "/v2/search") return jsonRes({ hits: [{ slug: "luckperms", title: "LuckPerms", description: "perms", downloads: 5, author: "Luck" }] });
    if (u.hostname === "api.modrinth.com" && u.pathname === "/v2/project/luckperms/version") return jsonRes([{ version_number: "5.4", version_type: "release", files: [{ primary: true, filename: "../../evil/LuckPerms-5.4.jar", url: "https://cdn.modrinth.com/data/x/LuckPerms.jar", hashes: { sha512: badHash ? "0".repeat(128) : sha512 } }] }]);
    if (u.hostname === "cdn.modrinth.com") return withUrl(new Response(JAR, { status: 200 }), url);
    if (u.hostname === "api.github.com" && u.pathname === "/orgs/MyTeam/repos") return jsonRes([{ name: "chat-plugin", full_name: "MyTeam/chat-plugin", description: "chat", private: true, archived: false }, { name: "old", full_name: "MyTeam/old", archived: true }]);
    if (u.hostname === "api.github.com" && u.pathname === "/repos/MyTeam/chat-plugin/releases/latest") return jsonRes({ tag_name: "v1.2", assets: [{ id: 11, name: "ChatPlugin-1.2.jar", size: 5000 }, { id: 12, name: "ChatPlugin-1.2-sources.jar", size: 100 }, { id: 13, name: "readme.txt" }] });
    if (u.hostname === "api.github.com" && u.pathname === "/repos/MyTeam/chat-plugin/releases/assets/11") return withUrl(new Response(JAR, { status: 200 }), redirectTo ?? "https://objects.githubusercontent.com/abc/ChatPlugin.jar");
    return new Response("nope", { status: 404 });
  };
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','MC','dummy',?,'ui')").run(JSON.stringify({ filesRoot: dir }));
  setSetting(db, "app.mc", JSON.stringify({ kind: "minecraft", flavor: "paper", version: "1.21.4" }));
  setSetting(db, "github_token", "ghp_SECRETTOKEN12345");
  const services = createServices({ db, dataDir: path.join(base, "data"), fetchImpl });
  const app = buildApp({ db, services, safeMode, dataDir: path.join(base, "data") });
  return { app, db, dir, seen };
}
async function as(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  const cookie = `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
  const call = (m, u, p) => f.app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" ? undefined : (p ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p) };
}

test("jar names are sanitised and can't escape the plugins folder", () => {
  assert.equal(safeJarName("../../etc/passwd"), "passwd.jar");
  assert.equal(safeJarName("Cool Plugin (1.2).jar"), "Cool Plugin (1.2).jar");
  assert.equal(safeJarName(".hidden.jar"), "hidden.jar");
  assert.ok(!safeJarName("x/../../y.jar").includes("/"));
});

test("list, disable, enable and delete plugins; bad names refused; operators can't touch them", async () => {
  const f = setup();
  const a = await as(f);
  const l = (await a.get("/api/servers/mc/mc/plugins")).json();
  assert.equal(l.kind, "plugins");
  assert.deepEqual(l.files.map((x) => [x.file, x.enabled]), [["EssentialsX.jar", true], ["Old.jar.disabled", false]]);
  assert.equal((await a.post("/api/servers/mc/mc/plugins/toggle", { file: "EssentialsX.jar", enabled: false })).statusCode, 200);
  assert.ok(existsSync(path.join(f.dir, "plugins", "EssentialsX.jar.disabled")));
  assert.equal((await a.post("/api/servers/mc/mc/plugins/toggle", { file: "Old.jar.disabled", enabled: true })).statusCode, 200);
  assert.ok(existsSync(path.join(f.dir, "plugins", "Old.jar")));
  for (const bad of ["../server.properties", "notes.txt", "a/b.jar", "..", "x.jar\n"]) {
    assert.equal((await a.post("/api/servers/mc/mc/plugins/delete", { file: bad })).statusCode, 400, bad);
  }
  assert.equal((await a.post("/api/servers/mc/mc/plugins/delete", { file: "Old.jar" })).statusCode, 200);
  assert.deepEqual(readdirSync(path.join(f.dir, "plugins")).sort(), ["EssentialsX.jar.disabled", "notes.txt"]);
  assert.ok(existsSync(path.join(f.dir, "server.properties")));
  const op = await as(f, "op", "pw-operator-1");
  assert.equal((await op.get("/api/servers/mc/mc/plugins")).statusCode, 403);
  assert.equal((await op.post("/api/servers/mc/mc/plugins/delete", { file: "x.jar" })).statusCode, 403);
  assert.ok(f.db.prepare("SELECT 1 FROM audit_log WHERE action = 'plugin_delete'").get());
});

test("Modrinth: search is scoped to this server's version and loader, install verifies the checksum and keeps the name inside plugins/", async () => {
  const f = setup();
  const a = await as(f);
  const s = (await a.get("/api/servers/mc/mc/modrinth/search?q=perm")).json();
  assert.equal(s.gameVersion, "1.21.4");
  assert.equal(s.hits[0].slug, "luckperms");
  const searchUrl = new URL(f.seen.find((x) => x.url.includes("/v2/search")).url);
  const facets = JSON.parse(searchUrl.searchParams.get("facets"));
  assert.deepEqual(facets[0], ["project_type:plugin"]);
  assert.ok(facets[1].includes("categories:paper"));
  assert.deepEqual(facets[2], ["versions:1.21.4"]);
  const r = await a.post("/api/servers/mc/mc/modrinth/install", { slug: "luckperms" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().file, "LuckPerms-5.4.jar"); // "../../evil/" stripped
  assert.ok(existsSync(path.join(f.dir, "plugins", "LuckPerms-5.4.jar")));
  assert.ok(!existsSync(path.join(f.dir, "..", "evil")));
  assert.equal((await a.post("/api/servers/mc/mc/modrinth/install", { slug: "luckperms" })).statusCode, 400); // already installed
  assert.equal((await a.post("/api/servers/mc/mc/modrinth/install", { slug: "../x" })).statusCode, 400);
  assert.ok(!f.seen.some((x) => x.auth), "the GitHub token must never go to Modrinth");
});

test("Modrinth: a download that doesn't match its checksum is thrown away", async () => {
  const f = setup({ badHash: true });
  const a = await as(f);
  const r = await a.post("/api/servers/mc/mc/modrinth/install", { slug: "luckperms" });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /checksum/);
  assert.deepEqual(readdirSync(path.join(f.dir, "plugins")).filter((n) => n.includes("LuckPerms")), []);
});

test("GitHub: org repo picker, release assets, token only to api.github.com, install from a private release", async () => {
  const f = setup();
  const a = await as(f);
  const repos = (await a.get("/api/github/repos?owner=MyTeam")).json();
  assert.deepEqual(repos.map((r) => r.full), ["MyTeam/chat-plugin"]); // archived hidden
  assert.equal(repos[0].private, true);
  assert.equal((await a.get("/api/github/repos?owner=../etc")).statusCode, 400);
  const rel = (await a.get("/api/github/releases?repo=MyTeam/chat-plugin")).json();
  assert.equal(rel.tag, "v1.2");
  assert.deepEqual(rel.assets.map((x) => [x.id, x.likely]), [[11, true], [12, false]]); // only jars, sources flagged
  const r = await a.post("/api/servers/mc/mc/github/install", { repo: "MyTeam/chat-plugin", assetId: 11 });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(existsSync(path.join(f.dir, "plugins", "ChatPlugin-1.2.jar")));
  assert.equal((await a.post("/api/servers/mc/mc/github/install", { repo: "MyTeam/chat-plugin", assetId: 999 })).statusCode, 400);
  assert.equal((await a.post("/api/servers/mc/mc/github/install", { repo: "https://evil.com/a/b", assetId: 11 })).statusCode, 400);
  const withAuth = f.seen.filter((x) => x.auth);
  assert.ok(withAuth.length > 0 && withAuth.every((x) => new URL(x.url).hostname === "api.github.com"));
  assert.ok(!JSON.stringify(f.seen.filter((x) => !x.auth)).includes("SECRETTOKEN"));
});

test("GitHub: a release asset that redirects to an unexpected host is refused", async () => {
  const f = setup({ redirectTo: "https://evil.example/ChatPlugin.jar" });
  const a = await as(f);
  const r = await a.post("/api/servers/mc/mc/github/install", { repo: "MyTeam/chat-plugin", assetId: 11 });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /isn't allowed/);
  assert.ok(!existsSync(path.join(f.dir, "plugins", "ChatPlugin-1.2.jar")));
});

test("plugin installs and removals are off in safe mode", async () => {
  const f = setup({ safeMode: true });
  const a = await as(f);
  assert.equal((await a.post("/api/servers/mc/mc/modrinth/install", { slug: "luckperms" })).statusCode, 403);
  assert.equal((await a.post("/api/servers/mc/mc/plugins/delete", { file: "Old.jar.disabled" })).statusCode, 403);
});

// Real fetch: does the Authorization header survive a cross-origin redirect? It must not.
test("real fetch drops the Authorization header when a download redirects to another origin", async () => {
  const got = {};
  const target = http.createServer((req, res) => ((got.target = req.headers.authorization ?? null), res.end("ok"))).listen(0, "127.0.0.1");
  const origin = http.createServer((req, res) => ((got.origin = req.headers.authorization ?? null), res.writeHead(302, { location: `http://127.0.0.1:${target.address().port}/f` }), res.end())).listen(0, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fetch(`http://127.0.0.1:${origin.address().port}/`, { headers: { authorization: "Bearer SECRET" }, redirect: "follow" });
    assert.equal(got.origin, "Bearer SECRET");
    assert.equal(got.target, null);
  } finally {
    origin.close();
    target.close();
  }
});
