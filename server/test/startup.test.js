import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { parseStart, buildStart, checkCustomFlag, restartCrons, createStartup } from "../src/mc/startup.js";

const CMD = "/usr/lib/jvm/java-21/bin/java -Xms2048M -Xmx2048M -jar server.jar nogui";

test("parse and build round-trip, aikar preset detected", () => {
  const p = parseStart(CMD);
  assert.deepEqual(p, { java: "/usr/lib/jvm/java-21/bin/java", memoryMb: 2048, preset: "none", custom: [], jar: "server.jar" });
  const built = buildStart({ ...p, memoryMb: 4096, preset: "aikar", custom: ["-Xss512k"] });
  assert.match(built, /-Xms4096M -Xmx4096M -XX:\+UseG1GC/);
  const again = parseStart(built);
  assert.equal(again.preset, "aikar");
  assert.deepEqual(again.custom, ["-Xss512k"]);
  assert.equal(parseStart("sh -c 'rm -rf /'"), null);
  assert.equal(parseStart("java -jar evil.sh nogui"), null);
});

test("custom flags: safe ones pass, anything that runs code or touches files is refused", () => {
  assert.equal(checkCustomFlag("-XX:+UseZGC"), "-XX:+UseZGC");
  assert.equal(checkCustomFlag("-XX:MaxGCPauseMillis=100"), "-XX:MaxGCPauseMillis=100");
  for (const bad of ["-javaagent:/tmp/x.jar", "-XX:OnOutOfMemoryError=reboot", "-XX:+HeapDumpOnOutOfMemoryError", "-XX:Flags=x", "-Dfoo=bar", "; rm -rf /", "$(id)", "-XX:+UseG1GC;id", "-Xss1g", "-XX:ErrorFile=/etc/x"]) {
    assert.throws(() => checkCustomFlag(bad), /allowed|too long|isn't/, bad);
  }
  assert.throws(() => buildStart({ java: "java; id", memoryMb: 1024 }), /Bad Java/);
  assert.throws(() => buildStart({ java: "java", memoryMb: 100 }), /Memory/);
  assert.throws(() => buildStart({ java: "java", memoryMb: 1024, jar: "../x.jar" }), /jar/);
});

test("restart schedule: warning five minutes ahead, wraps midnight", () => {
  assert.deepEqual(restartCrons("04:30"), { warn: "25 4 * * *", go: "30 4 * * *" });
  assert.deepEqual(restartCrons("00:02"), { warn: "57 23 * * *", go: "2 0 * * *" });
});

test("crash auto-restart: tries, caps at 3 per 30 min, off switch, ignores non-Console servers", async () => {
  let t = 0;
  const store = {};
  const su = createStartup({ getServer: () => null, saveTarget() {}, validateTarget: (_t, x) => x, cfgGet: () => store.c ?? null, cfgSet: (_i, v) => (store.c = v), now: () => t });
  const srv = { id: "a", name: "A", target: { startCommand: CMD } };
  const calls = [];
  const perform = async (...a) => calls.push(a);
  assert.deepEqual(await su.onCrash(srv, perform), { restarted: true, attempt: 1 });
  assert.equal(calls[0][1], "start");
  await su.onCrash(srv, perform); await su.onCrash(srv, perform);
  assert.deepEqual(await su.onCrash(srv, perform), { restarted: false, gaveUp: true });
  t += 31 * 60_000;
  assert.equal((await su.onCrash(srv, perform)).restarted, true, "window slides");
  store.c = { autoRestart: false };
  assert.equal((await su.onCrash(srv, perform)).restarted, false);
  assert.equal((await su.onCrash({ id: "b", target: { startCommand: "node app.js" } }, perform)).restarted, false);
});

async function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "console-start-"));
  const dir = path.join(base, "srv");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "motd=x\n");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('mc','Mine','tmux',?,'ui')").run(
    JSON.stringify({ session: "mc-mc", startCommand: CMD, cwd: dir, stopCommand: "stop", filesRoot: dir })
  );
  const services = createServices({ db, dataDir: path.join(base, "data") });
  const app = buildApp({ db, services, dataDir: path.join(base, "data") });
  const login = await app.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const cookie = `console_session=${login.cookies.find((c) => c.name === "console_session").value}`;
  const call = (method, url, payload) => app.inject({ method, url, headers: { cookie }, payload });
  return { app, db, call };
}

test("startup API: view, change memory/preset, daily restart schedules, bad input refused", async () => {
  const f = await setup();
  let r = await f.call("GET", "/api/servers/mc/mc/startup");
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().memoryMb, 2048);
  assert.equal(r.json().autoRestart, true);

  r = await f.call("PUT", "/api/servers/mc/mc/startup", { memoryMb: 3072, preset: "aikar", dailyRestart: "04:30" });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().memoryMb, 3072);
  assert.equal(r.json().preset, "aikar");
  assert.equal(r.json().restartNeeded, true);
  const target = JSON.parse(f.db.prepare("SELECT target FROM servers WHERE id='mc'").get().target);
  assert.match(target.startCommand, /-Xmx3072M/);
  assert.equal(target.cwd.length > 0, true, "other target fields survive");
  let rows = f.db.prepare("SELECT action, cron FROM schedules WHERE created_by='panel:restart' ORDER BY id").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [{ action: "command", cron: "25 4 * * *" }, { action: "restart", cron: "30 4 * * *" }]);

  r = await f.call("PUT", "/api/servers/mc/mc/startup", { dailyRestart: "05:00" });
  rows = f.db.prepare("SELECT cron FROM schedules WHERE created_by='panel:restart'").all();
  assert.equal(rows.length, 2, "replaced, not duplicated");
  r = await f.call("PUT", "/api/servers/mc/mc/startup", { dailyRestart: null });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM schedules WHERE created_by='panel:restart'").get().n, 0);

  for (const body of [{ memoryMb: 10 }, { memoryMb: 99999999 }, { customFlags: ["-javaagent:x.jar"] }, { preset: "nope" }, { dailyRestart: "25:99" }]) {
    r = await f.call("PUT", "/api/servers/mc/mc/startup", body);
    assert.equal(r.statusCode, 400, JSON.stringify(body) + r.body);
  }
});
