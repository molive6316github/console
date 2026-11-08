import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { CATALOG, BUNDLES } from "../src/mc/catalog.js";

const JAR = Buffer.alloc(5000, 9);
const sha512 = createHash("sha512").update(JAR).digest("hex");
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const withUrl = (r, url) => (Object.defineProperty(r, "url", { value: url }), r);

// Pretend Modrinth: some projects exist, "worldguard" requires "worldedit", "vault" doesn't exist but its fork does.
const PROJECTS = {
  essentialsx: { loaders: ["paper", "spigot"], game_versions: ["1.21.4"] },
  luckperms: { loaders: ["paper"], game_versions: ["1.21.4"] },
  worldguard: { loaders: ["paper"], game_versions: ["1.21.4"], deps: ["WEDIT123"] },
  worldedit: { loaders: ["paper"], game_versions: ["1.21.4"], id: "WEDIT123" },
  vaultunlocked: { loaders: ["paper"], game_versions: ["1.21.4"] },
  oldplugin: { loaders: ["paper"], game_versions: ["1.8"] },
  fabricmod: { loaders: ["fabric"], game_versions: ["1.21.4"] },
};
for (const s of ["quickshop-hikari", "coreprotect", "huskclaims"]) PROJECTS[s] = { loaders: ["paper"], game_versions: ["1.21.4"] };
PROJECTS.geyser = { loaders: ["paper"], game_versions: ["1.20"] }; // not for this Minecraft version

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "console-cat-"));
  const dir = path.join(base, "mc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=x\n");
  let projectCalls = 0;
  const fetchImpl = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/v2/projects") {
      projectCalls++;
      return json(Object.entries(PROJECTS).map(([slug, p]) => ({ slug, project_type: "plugin", loaders: p.loaders, game_versions: p.game_versions, downloads: 10 })));
    }
    const pm = /^\/v2\/project\/([^/]+)(\/version)?$/.exec(u.pathname);
    if (pm) {
      const [, key, isVersions] = pm;
      const bySlug = PROJECTS[key];
      const byId = Object.entries(PROJECTS).find(([, p]) => p.id === key);
      if (!isVersions && byId) return json({ slug: byId[0] });
      if (isVersions && bySlug) return json([{ version_type: "release", version_number: "1.0", dependencies: (bySlug.deps ?? []).map((d) => ({ project_id: d, dependency_type: "required" })), files: [{ primary: true, filename: `${key}.jar`, url: `https://cdn.modrinth.com/${key}.jar`, hashes: { sha512 } }] }]);
    }
    if (u.hostname === "cdn.modrinth.com") return withUrl(new Response(JAR, { status: 200 }), url);
    return new Response("nope", { status: 404 });
  };
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','MC','dummy',?,'ui')").run(JSON.stringify({ filesRoot: dir }));
  setSetting(db, "app.mc", JSON.stringify({ kind: "minecraft", flavor: "paper", version: "1.21.4" }));
  const services = createServices({ db, dataDir: path.join(base, "data"), fetchImpl });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  return { app, dir, calls: () => projectCalls };
}
async function login(f) {
  const r = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const cookie = `console_session=${r.cookies.find((c) => c.name === "console_session").value}`;
  return (m, u, p) => f.app.inject({ method: m, url: u, headers: { cookie }, payload: m === "GET" ? undefined : (p ?? {}) });
}

test("catalog data is sane: unique slugs, known categories, bundles only use catalog slugs", () => {
  const slugs = CATALOG.map((c) => c.slug);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const b of BUNDLES) for (const s of b.slugs) assert.ok(slugs.includes(s), `${b.id} uses unknown ${s}`);
});

test("only plugins that exist for this server's version and loader are shown; forks stand in; bundles shrink to what exists", async () => {
  const f = setup();
  const call = await login(f);
  const r = (await call("GET", "/api/servers/mc/mc/catalog")).json();
  const got = r.items.map((i) => i.slug).sort();
  assert.ok(got.includes("essentialsx") && got.includes("luckperms") && got.includes("worldguard"));
  assert.ok(got.includes("vaultunlocked") && !got.includes("vault"), "the fork takes the Vault slot");
  assert.ok(!got.includes("geyser"), "wrong Minecraft version is hidden");
  assert.ok(!got.includes("fabricmod") && !got.includes("oldplugin"), "never anything outside the curated list");
  const eco = r.bundles.find((b) => b.id === "economy");
  assert.deepEqual(eco.slugs.sort(), ["essentialsx", "quickshop-hikari", "vaultunlocked"]);
  assert.ok(r.categories.length > 3);
  await call("GET", "/api/servers/mc/mc/catalog");
  assert.equal(f.calls(), 1, "cached");
});

test("installing pulls required dependencies, skips what's already there, refuses anything off-catalog", async () => {
  const f = setup();
  const call = await login(f);
  let r = await call("POST", "/api/servers/mc/mc/catalog/install", { slugs: ["worldguard"] });
  assert.equal(r.statusCode, 200, r.body);
  const res = r.json().results;
  assert.deepEqual(res.map((x) => x.slug), ["worldguard", "worldedit"], "dependency came along");
  assert.deepEqual(readdirSync(path.join(f.dir, "plugins")).sort(), ["worldedit.jar", "worldguard.jar"]);
  r = await call("POST", "/api/servers/mc/mc/catalog/install", { slugs: ["worldguard", "luckperms"] });
  const again = r.json().results;
  assert.equal(again.find((x) => x.slug === "worldguard").skipped, true);
  assert.equal(again.find((x) => x.slug === "luckperms").ok, true);
  r = await call("POST", "/api/servers/mc/mc/catalog/install", { slugs: ["../../etc/passwd", "evil-plugin"] });
  assert.equal(r.statusCode, 400, "off-catalog slugs are refused outright");
});
