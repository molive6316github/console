import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { isOlder } from "../src/mc/versions.js";

const CMD = "/usr/bin/java -Xms2048M -Xmx2048M -jar server.jar nogui";

async function setup({ failDownload = false } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "console-ver-"));
  const dir = path.join(base, "srv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=x\n");
  writeFileSync(path.join(dir, "server.jar"), "OLDJAR");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','Mine','tmux',?,'ui')").run(
    JSON.stringify({ session: "mc-vtest-none", startCommand: CMD, cwd: dir, stopCommand: "stop", filesRoot: dir })
  );
  setSetting(db, "app.mc", JSON.stringify({ kind: "minecraft", flavor: "paper", version: "1.21.4" }));
  const calls = [];
  const services = createServices({
    db, dataDir: path.join(base, "data"),
    mcOptions: {
      versionDeps: {
        resolve: async (_f, flavor, version) => { calls.push(["resolve", flavor, version]); return { url: "https://x/y.jar", java: 21 }; },
        dl: async (_f, _u, dest) => { if (failDownload) throw new Error("boom"); writeFileSync(dest, "NEWJAR"); },
        java: async () => ({ major: 21, bin: "/opt/j21/bin/java" }),
      },
    },
  });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const cookie = `console_session=${login.cookies.find((c) => c.name === "console_session").value}`;
  const call = (method, url, payload) => app.inject({ method, url, headers: { cookie }, payload });
  const waitJob = async (id) => {
    for (let i = 0; i < 100; i++) {
      const j = (await call("GET", `/api/servers/mc/mc/job/${id}`)).json();
      if (j.status !== "running") return j;
      await new Promise((r) => setTimeout(r, 30));
    }
    throw new Error("job never finished");
  };
  return { db, dir, call, waitJob, calls };
}

test("version compare", () => {
  assert.equal(isOlder("1.20.4", "1.21"), true);
  assert.equal(isOlder("1.21.4", "1.21.4"), false);
  assert.equal(isOlder("1.21.10", "1.21.9"), false);
});

test("switch: guards, backup, jar swap with old kept, start command + meta updated", async () => {
  const f = await setup();
  let r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "paper", version: "1.21.5" });
  assert.equal(r.statusCode, 400, "needs the server id typed");
  r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "purpur", version: "1.21.5", confirm: "mc" });
  assert.equal(r.statusCode, 409, "type change needs an explicit tick");
  r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "paper", version: "1.20.1", confirm: "mc" });
  assert.equal(r.statusCode, 409, "downgrade needs an explicit tick");
  r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "nope", version: "1.21.5", confirm: "mc" });
  assert.equal(r.statusCode, 400);
  assert.equal(readFileSync(path.join(f.dir, "server.jar"), "utf8"), "OLDJAR", "refusals touch nothing");

  r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "paper", version: "1.21.5", confirm: "mc" });
  assert.equal(r.statusCode, 200, r.body);
  const job = await f.waitJob(r.json().jobId);
  assert.equal(job.status, "done", JSON.stringify(job));
  assert.equal(readFileSync(path.join(f.dir, "server.jar"), "utf8"), "NEWJAR");
  const kept = readdirSync(f.dir).filter((n) => n.startsWith("server.jar.before-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(path.join(f.dir, kept[0]), "utf8"), "OLDJAR");
  assert.ok(!existsSync(path.join(f.dir, "server.jar.new")));
  const t = JSON.parse(f.db.prepare("SELECT target FROM servers WHERE id='mc'").get().target);
  assert.match(t.startCommand, /^\/opt\/j21\/bin\/java -Xms2048M -Xmx2048M -jar server.jar nogui$/);
  assert.deepEqual(JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='app.mc'").get().value), { kind: "minecraft", flavor: "paper", version: "1.21.5" });
  assert.ok(readdirSync(path.join(f.dir, "..", "data", "backups", "mc")).length >= 1, "a backup was taken first");
  assert.equal((await f.call("GET", "/api/servers/mc/mc/job/deadbeef")).statusCode, 404);
});

test("switch: a failed download leaves the old server exactly as it was", async () => {
  const f = await setup({ failDownload: true });
  const r = await f.call("POST", "/api/servers/mc/mc/version", { flavor: "purpur", version: "1.21.5", confirm: "mc", acceptFlavorChange: true });
  assert.equal(r.statusCode, 200, r.body);
  const job = await f.waitJob(r.json().jobId);
  assert.equal(job.status, "failed");
  assert.equal(readFileSync(path.join(f.dir, "server.jar"), "utf8"), "OLDJAR");
  assert.equal(JSON.parse(f.db.prepare("SELECT target FROM servers WHERE id='mc'").get().target).startCommand, CMD);
  assert.equal(JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key='app.mc'").get().value).flavor, "paper");
});
