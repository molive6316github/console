import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { parseRepo, gitEnv } from "../src/gitutil.js";
import { createJobs } from "../src/jobs.js";
import { parseEnvText, javaNeededFor, javaMajorOf } from "../src/setups/common.js";
import { dockerArgs, DOCKER_APPS } from "../src/setups/dockerapps.js";
import { buildStart } from "../src/setups/gitapp.js";
import { listVersions, resolveDownload } from "../src/setups/minecraft.js";

// ---- pure bits ----------------------------------------------------------------------
test("repo input: owner/repo and links are accepted, anything else is refused", () => {
  assert.equal(parseRepo("me/my-bot").url, "https://github.com/me/my-bot.git");
  assert.equal(parseRepo("https://github.com/me/my-bot.git").slug, "me/my-bot");
  assert.equal(parseRepo("git@github.com:me/my-bot.git").url, "https://github.com/me/my-bot.git");
  assert.equal(parseRepo("github.com/me/my-bot/").slug, "me/my-bot");
  assert.equal(parseRepo("https://gitlab.com/a/b").host, "gitlab.com");
  for (const bad of ["", "justone", "http://github.com/a/b", "https://evil.com/a/b", "https://u:p@github.com/a/b", "me/../x", "me/b;rm -rf", "file:///etc", "https://github.com/a/b c", "--upload-pack=x/y"]) {
    assert.throws(() => parseRepo(bad), undefined, bad);
  }
});

test("the GitHub token goes through git's environment, never the command line", () => {
  const env = gitEnv("ghp_secret123");
  assert.match(env.GIT_CONFIG_VALUE_0, /^Authorization: Basic /);
  assert.ok(!JSON.stringify(env).includes("ghp_secret123")); // only base64 inside the header
  assert.deepEqual(gitEnv("ghp_secret123", "gitlab.com"), { GIT_TERMINAL_PROMPT: "0" }); // never sent to other hosts
});

test("env text parsing and quoting survive nasty values", () => {
  assert.deepEqual(parseEnvText('A=1\n# c\nB="two words"\nC=it\'s\n'), [["A", "1"], ["B", "two words"], ["C", "it's"]]);
  assert.throws(() => parseEnvText("not valid"));
  assert.throws(() => parseEnvText("1BAD=x"));
});

test("java requirements by Minecraft version", () => {
  assert.equal(javaNeededFor("1.21.4"), 21);
  assert.equal(javaNeededFor("1.20.4"), 17);
  assert.equal(javaNeededFor("1.20.5"), 21);
  assert.equal(javaNeededFor("1.16.5"), 8);
  assert.equal(javaNeededFor("26.1"), 25);
  assert.equal(javaMajorOf('openjdk version "21.0.2" 2024'), 21);
  assert.equal(javaMajorOf('java version "1.8.0_392"'), 8);
});

test("start command: loads .env, restarts on crash only when asked, and quotes the folder", () => {
  const a = buildStart({ dir: "/home/opc/servers/bot", command: "node index.js", kind: "node", autoRestart: true });
  assert.match(a, /^cd '\/home\/opc\/servers\/bot' &&/);
  assert.match(a, /while true; do node index\.js;/);
  const b = buildStart({ dir: "/x", command: "python bot.py", kind: "python", autoRestart: false });
  assert.doesNotMatch(b, /while true/);
  assert.match(b, /\.venv\/bin/);
});

test("docker run arguments: named volumes, restart policy, env passed as separate args", () => {
  const args = dockerArgs({ id: "kuma", image: "louislam/uptime-kuma:latest", ports: [[3001, 3001]], env: [["A", "x y; rm -rf /"]] }, DOCKER_APPS["uptime-kuma"]);
  assert.deepEqual(args.slice(0, 6), ["run", "-d", "--name", "kuma", "--restart", "unless-stopped"]);
  assert.ok(args.includes("console-kuma-0:/app/data"));
  assert.ok(args.includes("A=x y; rm -rf /")); // one argv entry, no shell involved
});

test("Minecraft version lists and download links come from the vendors' APIs (faked here)", async () => {
  const routes = {
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json": { versions: [{ id: "1.21.4", type: "release", url: "https://piston-meta.mojang.com/v/1.21.4.json" }, { id: "24w01a", type: "snapshot", url: "x" }] },
    "https://piston-meta.mojang.com/v/1.21.4.json": { downloads: { server: { url: "https://piston-data.mojang.com/s.jar", sha1: "abc" } }, javaVersion: { majorVersion: 21 } },
    "https://fill.papermc.io/v3/projects/paper": { versions: { "1.21": ["1.21.4", "1.21.3", "1.21.4-rc1"], "1.20": ["1.20.6"] } },
    "https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds/latest": { downloads: { "server:default": { url: "https://fill-data.papermc.io/p.jar" } } },
    "https://api.purpurmc.org/v2/purpur": { versions: ["1.20.6", "1.21.4"] },
    "https://meta.fabricmc.net/v2/versions/game": [{ version: "1.21.4", stable: true }, { version: "snap", stable: false }],
    "https://meta.fabricmc.net/v2/versions/loader": [{ version: "0.16.9", stable: true }],
    "https://meta.fabricmc.net/v2/versions/installer": [{ version: "1.0.1", stable: true }],
  };
  const f = async (url) => (url in routes ? { ok: true, status: 200, json: async () => routes[url] } : { ok: false, status: 404 });
  assert.deepEqual(await listVersions(f, "vanilla"), ["1.21.4"]);
  assert.deepEqual(await listVersions(f, "paper"), ["1.21.4", "1.21.3", "1.20.6"]);
  assert.deepEqual(await listVersions(f, "purpur"), ["1.21.4", "1.20.6"]);
  assert.deepEqual(await listVersions(f, "fabric"), ["1.21.4"]);
  assert.equal((await resolveDownload(f, "vanilla", "1.21.4")).java, 21);
  assert.equal((await resolveDownload(f, "paper", "1.21.4")).url, "https://fill-data.papermc.io/p.jar");
  assert.match((await resolveDownload(f, "fabric", "1.21.4")).url, /loader\/1\.21\.4\/0\.16\.9\/1\.0\.1\/server\/jar$/);
  await assert.rejects(resolveDownload(f, "vanilla", "9.9.9"), /doesn't exist/);
});

// ---- jobs -----------------------------------------------------------------------------
const wait = async (jobs, id) => {
  for (let i = 0; i < 400; i++) {
    const j = jobs.get(id);
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job never finished");
};

test("jobs stream output, hide secrets, and report failures plainly", async () => {
  const jobs = createJobs();
  const ok = jobs.start({ title: "t", actor: "a", redact: ["SECRET"] }, async (ctx) => {
    await ctx.exec("sh", ["-c", "echo hello SECRET; echo err >&2"]);
    return { x: 1 };
  });
  const done = await wait(jobs, ok.id);
  assert.equal(done.status, "done");
  assert.match(done.log, /hello ••••/);
  assert.doesNotMatch(done.log, /SECRET/);
  assert.match(done.log, /err/);
  const bad = jobs.start({ title: "t", actor: "a" }, async (ctx) => ctx.exec("sh", ["-c", "exit 3"]));
  const failed = await wait(jobs, bad.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /exit 3/);
  const missing = await wait(jobs, jobs.start({ title: "t", actor: "a" }, (ctx) => ctx.exec("definitely-not-a-command", [])).id);
  assert.match(missing.error, /not installed/);
  const boom = await wait(jobs, jobs.start({ title: "t", actor: "a" }, async () => { throw new Error("db path /secret"); }).id);
  assert.match(boom.error, /Unexpected problem/);
});

// ---- the whole thing through the API, with fake tools on PATH ---------------------------
function fakeBin(dir, name, body) {
  const f = path.join(dir, name);
  writeFileSync(f, `#!/bin/sh\n${body}\n`);
  chmodSync(f, 0o755);
}

function setup({ safeMode = false, fetchImpl, ...extra } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-setup-"));
  const bin = path.join(base, "bin");
  mkdirSync(bin);
  const db = openDb(":memory:");
  const add = db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES (?, ?, ?, 1)");
  add.run("boss", hashPassword("pw-admin-123"), "admin");
  add.run("op", hashPassword("pw-operator-1"), "operator");
  const started = [];
  const services = createServices({
    db,
    dataDir: path.join(base, "data"),
    fetchImpl,
    setupOptions: {
      appsDir: path.join(base, "apps"),
      jvmDir: path.join(base, "nojvm"),
      caddy: { sitesDir: path.join(base, "caddy-sites"), sitesRoot: path.join(base, "sites"), caddyfile: path.join(base, "Caddyfile") },
      publicIp: "203.0.113.9",
      startServer: async (id) => started.push(id),
      ...extra,
    },
  });
  const app = buildApp({ db, services, safeMode, dataDir: path.join(base, "data") });
  return { app, db, base, bin, services, started };
}
async function admin(f, who = "boss", pw = "pw-admin-123") {
  const res = await f.app.inject({ method: "POST", url: "/api/login", payload: { username: who, password: pw } });
  const cookie = `console_session=${res.cookies.find((c) => c.name === "console_session").value}`;
  const call = (method, url, payload) => f.app.inject({ method, url, headers: { cookie }, payload: method === "GET" ? undefined : (payload ?? {}) });
  return { get: (u) => call("GET", u), post: (u, p) => call("POST", u, p), put: (u, p) => call("PUT", u, p) };
}
async function finish(f, a, res) {
  assert.equal(res.statusCode, 200, res.body);
  const { jobId } = res.json();
  for (let i = 0; i < 600; i++) {
    const j = (await a.get(`/api/jobs/${jobId}`)).json();
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("job timeout");
}

test("only admins can set things up, and safe mode turns it off", async () => {
  const f = setup();
  const op = await admin(f, "op", "pw-operator-1");
  assert.equal((await op.post("/api/setup/minecraft", {})).statusCode, 403);
  assert.equal((await op.get("/api/setup/catalog")).statusCode, 403);
  assert.equal((await op.get("/api/jobs")).statusCode, 403);
  const safe = setup({ safeMode: true });
  const a = await admin(safe);
  assert.equal((await a.post("/api/setup/minecraft", {})).statusCode, 403);
  const boss = await admin(f);
  assert.equal((await boss.post("/api/setup/nope", {})).statusCode, 400);
  const cat = (await boss.get("/api/setup/catalog")).json();
  assert.deepEqual(cat.map((t) => t.id).sort(), ["docker", "git-app", "minecraft", "static-site"]);
});

test("bad input is refused before any work starts, with a clear message", async () => {
  const f = setup();
  const a = await admin(f);
  const r = await a.post("/api/setup/minecraft", { name: "x", flavor: "paper", version: "1.21.4", acceptEula: false });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /EULA/);
  assert.equal((await a.post("/api/setup/git-app", { repo: "https://evil.com/a/b" })).statusCode, 400);
  assert.equal((await a.post("/api/setup/static-site", { domain: "not a domain" })).statusCode, 400);
  assert.equal((await a.post("/api/setup/docker", { app: "custom", image: "bad image; rm" })).statusCode, 400);
  assert.equal((await a.post("/api/setup/docker", { app: "uptime-kuma", hostPort: 80 })).statusCode, 400);
});

test("Minecraft end to end (fake downloads, fake java)", async () => {
  const f = setup({
    fetchImpl: async (url) => {
      if (url.endsWith("version_manifest_v2.json")) return { ok: true, status: 200, json: async () => ({ versions: [{ id: "1.21.4", type: "release", url: "https://piston-meta.mojang.com/v.json" }] }) };
      if (url.endsWith("v.json")) return { ok: true, status: 200, json: async () => ({ downloads: { server: { url: "https://piston-data.mojang.com/s.jar" } }, javaVersion: { majorVersion: 21 } }) };
      return new Response(Buffer.alloc(300_000, 1), { status: 200 });
    },
  });
  fakeBin(f.bin, "java", `echo 'openjdk version "21.0.2" 2024-01-16' >&2`);
  const old = process.env.PATH;
  process.env.PATH = `${f.bin}:${old}`;
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/minecraft", { name: "Survival SMP", flavor: "vanilla", version: "1.21.4", memoryMb: 3072, port: 25570, acceptEula: true, openFirewall: false }));
    assert.equal(job.status, "done", job.log + job.error);
    const dir = path.join(f.base, "apps", "survival-smp");
    assert.equal(statSync(path.join(dir, "server.jar")).size, 300_000);
    assert.match(readFileSync(path.join(dir, "eula.txt"), "utf8"), /eula=true/);
    assert.match(readFileSync(path.join(dir, "server.properties"), "utf8"), /server-port=25570/);
    const row = f.db.prepare("SELECT * FROM servers WHERE id = 'survival-smp'").get();
    assert.equal(row.source, "ui");
    const t = JSON.parse(row.target);
    assert.equal(t.startCommand, "java -Xms3072M -Xmx3072M -jar server.jar nogui");
    assert.equal(t.stopCommand, "stop");
    assert.equal(t.filesRoot, dir);
    assert.deepEqual(f.started, ["survival-smp"]);
    assert.match(job.log, /203\.0\.113\.9:25570/);
    // same name again is refused up front
    const again = await a.post("/api/setup/minecraft", { name: "Survival SMP", flavor: "vanilla", version: "1.21.4", acceptEula: true });
    assert.equal(again.statusCode, 400);
  } finally {
    process.env.PATH = old;
  }
});

test("Minecraft refuses a download that redirects somewhere unexpected", async () => {
  const f = setup({
    fetchImpl: async (url) => {
      if (url.includes("purpurmc.org") && url.endsWith("/download")) { const r = new Response(Buffer.alloc(300_000), { status: 200 }); Object.defineProperty(r, "url", { value: "https://evil.example/x.jar" }); return r; }
      return { ok: false, status: 404 };
    },
  });
  fakeBin(f.bin, "java", `echo 'openjdk version "21.0.2"' >&2`);
  const old = process.env.PATH;
  process.env.PATH = `${f.bin}:${old}`;
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/minecraft", { name: "p", flavor: "purpur", version: "1.21.4", acceptEula: true, openFirewall: false }));
    assert.equal(job.status, "failed");
    assert.match(job.error, /isn't allowed/);
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM servers").get().n, 0);
  } finally {
    process.env.PATH = old;
  }
});

test("Docker app: pulls, runs with a restart policy, hides env values from the log, adds a docker server", async () => {
  const f = setup();
  const calls = path.join(f.base, "docker-calls.txt");
  fakeBin(f.bin, "docker", `echo "$@" >> ${calls}\nexit 0`);
  const old = process.env.PATH;
  process.env.PATH = `${f.bin}:${old}`;
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/docker", { app: "custom", name: "My Bot", image: "ghcr.io/me/bot:1.2", containerPort: 8080, hostPort: 8088, envText: "TOKEN=supersecret" }));
    assert.equal(job.status, "done", job.log + job.error);
    const lines = readFileSync(calls, "utf8").trim().split("\n");
    assert.ok(lines.some((l) => l.startsWith("pull ghcr.io/me/bot:1.2")));
    const runLine = lines.find((l) => l.startsWith("run -d --name my-bot"));
    assert.match(runLine, /--restart unless-stopped/);
    assert.match(runLine, /-p 8088:8080/);
    assert.match(runLine, /-e TOKEN=supersecret/);
    assert.doesNotMatch(job.log, /supersecret/);
    assert.deepEqual(JSON.parse(f.db.prepare("SELECT target FROM servers WHERE id = 'my-bot'").get().target), { container: "my-bot" });
  } finally {
    process.env.PATH = old;
  }
});

test("Docker app: a permissions problem gets a fix, not a stack trace", async () => {
  const f = setup({ user: "opc" });
  fakeBin(f.bin, "docker", `echo "permission denied while trying to connect to the Docker daemon socket" >&2\nexit 1`);
  const old = process.env.PATH;
  process.env.PATH = `${f.bin}:${old}`;
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/docker", { app: "uptime-kuma", name: "Kuma" }));
    assert.equal(job.status, "failed");
    assert.match(job.error, /usermod -aG docker opc/);
  } finally {
    process.env.PATH = old;
  }
});

test("App from GitHub: clones, installs, writes a private .env, picks a start command, and can update", async () => {
  const f = setup();
  // A local "GitHub": git rewrites https://github.com/me/bot.git to this folder.
  const gh = path.join(f.base, "gh");
  const src = path.join(gh, "me", "bot.git");
  mkdirSync(src, { recursive: true });
  const sh = (cmd, cwd) => spawnSync("sh", ["-c", cmd], { cwd, encoding: "utf8" });
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: "bot", version: "1.0.0", scripts: { start: "node index.js" } }));
  writeFileSync(path.join(src, "index.js"), "console.log('v1')\n");
  sh("git init -q -b main && git add -A && git -c user.email=a@b -c user.name=t commit -qm one", src);
  const oldEnv = { ...process.env };
  Object.assign(process.env, { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${gh}/.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/", GIT_ALLOW_PROTOCOL: "file:https" });
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/git-app", { repo: "me/bot", envText: "DISCORD_TOKEN=a'b\"c $HOME", autoRestart: true }));
    assert.equal(job.status, "done", job.log + job.error);
    const dir = path.join(f.base, "apps", "bot");
    assert.equal((statSync(path.join(dir, ".env")).mode & 0o777), 0o600);
    // The value must survive being sourced by a shell, byte for byte, and not be expanded.
    const echoed = spawnSync("bash", ["-c", `set -a; . ./.env; set +a; printf %s "$DISCORD_TOKEN"`], { cwd: dir, encoding: "utf8" });
    assert.equal(echoed.stdout, `a'b"c $HOME`);
    const t = JSON.parse(f.db.prepare("SELECT target FROM servers WHERE id = 'bot'").get().target);
    assert.match(t.startCommand, /while true; do npm start;/);
    assert.equal(t.cwd, dir);
    assert.deepEqual(f.started, ["bot"]);
    assert.deepEqual((await a.get("/api/servers/bot/git")).json(), { repo: "me/bot", branch: null, kind: "node" });
    // the secret is not in the job log or the audit trail
    assert.doesNotMatch(job.log, /DISCORD_TOKEN|\$HOME/);
    // push a new commit and update
    writeFileSync(path.join(src, "index.js"), "console.log('v2')\n");
    sh("git add -A && git -c user.email=a@b -c user.name=t commit -qm two", src);
    const upd = await finish(f, a, await a.post("/api/servers/bot/git-update", {}));
    assert.equal(upd.status, "done", upd.log + upd.error);
    assert.match(readFileSync(path.join(dir, "index.js"), "utf8"), /v2/);
    assert.deepEqual(upd.result, { changed: true });
    // not something Console set up
    assert.equal((await a.post("/api/servers/nothing/git-update", {})).statusCode, 400);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
    Object.assign(process.env, oldEnv);
  }
});

test("a saved GitHub token is masked in settings and never appears in a job log", async () => {
  const f = setup();
  const a = await admin(f);
  const put = await a.put("/api/settings", { githubToken: "ghp_ABCDEFGHIJ1234" });
  assert.equal(put.statusCode, 200);
  assert.equal(put.json().githubToken, "••••1234");
  assert.ok(!put.body.includes("ghp_ABCDEFGHIJ"));
  assert.equal((await a.put("/api/settings", { githubToken: "has space" })).statusCode, 400);
  // a failing clone (git can't reach github from here) must not echo the token
  const job = await finish(f, a, await a.post("/api/setup/git-app", { repo: "nobody/nothing-here-xyz" }));
  assert.equal(job.status, "failed");
  assert.doesNotMatch(job.log + job.error, /ghp_ABCDEFGHIJ1234/);
  assert.doesNotMatch(job.log, new RegExp(Buffer.from("x-access-token:ghp_ABCDEFGHIJ1234").toString("base64")));
});

test("Static site: writes a Caddy block, validates before reloading, and rolls back if validation fails", async () => {
  const f = setup();
  mkdirSync(path.join(f.base, "caddy-sites"));
  const log = path.join(f.base, "calls.txt");
  fakeBin(f.bin, "caddy", "exit 0");
  fakeBin(f.bin, "sudo", `echo "$@" >> ${log}\nshift\nif [ "$1" = caddy ] && [ -f ${f.base}/invalid ]; then echo bad config >&2; exit 1; fi\nexit 0`);
  const old = process.env.PATH;
  process.env.PATH = `${f.bin}:${old}`;
  try {
    const a = await admin(f);
    const job = await finish(f, a, await a.post("/api/setup/static-site", { domain: "Www.Example.com", source: "blank" }));
    assert.equal(job.status, "done", job.log + job.error);
    const site = readFileSync(path.join(f.base, "caddy-sites", "www.example.com.caddy"), "utf8");
    assert.match(site, /^www\.example\.com \{$/m);
    assert.match(site, new RegExp(`root \\* ${path.join(f.base, "sites", "www.example.com").replace(/[/.]/g, "\\$&")}$`, "m"));
    assert.match(readFileSync(path.join(f.base, "sites", "www.example.com", "index.html"), "utf8"), /is live/);
    const calls = readFileSync(log, "utf8");
    assert.ok(calls.indexOf("validate") < calls.indexOf("reload"), calls);
    const row = f.db.prepare("SELECT type, target FROM servers WHERE id = 'www-example-com'").get();
    assert.equal(row.type, "http");
    assert.equal(JSON.parse(row.target).url, "https://www.example.com");
    assert.match(job.log, /203\.0\.113\.9/);
    // now make validation fail: nothing may be left behind
    writeFileSync(path.join(f.base, "invalid"), "");
    const bad = await finish(f, a, await a.post("/api/setup/static-site", { domain: "other.example.com", source: "blank" }));
    assert.equal(bad.status, "failed");
    assert.ok(!existsSync(path.join(f.base, "caddy-sites", "other.example.com.caddy")));
    assert.ok(!existsSync(path.join(f.base, "sites", "other.example.com")));
    assert.equal(f.db.prepare("SELECT COUNT(*) n FROM servers WHERE id LIKE 'other%'").get().n, 0);
  } finally {
    process.env.PATH = old;
  }
});

test("Static site without Caddy installed says exactly what to do", async () => {
  const f = setup();
  const a = await admin(f);
  const job = await finish(f, a, await a.post("/api/setup/static-site", { domain: "a.example.com" }));
  assert.equal(job.status, "failed");
  assert.match(job.error, /Caddy|installer/);
});

test("readiness check reports what's installed", async () => {
  const f = setup({ user: "opc" });
  const a = await admin(f);
  const s = (await a.get("/api/setup/status")).json();
  assert.equal(s.user, "opc");
  assert.equal(typeof s.docker, "boolean");
  assert.equal(s.publicIp, "203.0.113.9");
  assert.equal(s.githubToken, false);
});
