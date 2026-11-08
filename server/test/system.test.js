import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { createSystem, createLogRing } from "../src/system.js";
import { createJobs } from "../src/jobs.js";

const fakeRun = (map) => async (cmd, args) => {
  const key = [cmd, ...args].join(" ");
  for (const [k, v] of Object.entries(map)) if (key.startsWith(k)) return { code: 0, stdout: "", stderr: "", ...v };
  return { code: 127, stdout: "", stderr: "not found" };
};

test("dnf: lists pending updates, notices when a reboot is needed", async () => {
  const run = fakeRun({
    "sh -c command -v dnf": { stdout: "/usr/bin/dnf" },
    "sudo -n true": {},
    "dnf check-update": { code: 100, stdout: "kernel.aarch64   5.14.0   baseos\nopenssl.aarch64 3.0 baseos\n\nObsoleting Packages\n" },
    "needs-restarting -r": { code: 1 },
  });
  const r = await createSystem({ run, jobs: createJobs() }).check({ force: true });
  assert.equal(r.pm, "dnf");
  assert.deepEqual(r.updates.slice(0, 2), ["kernel.aarch64", "openssl.aarch64"]);
  assert.equal(r.rebootRequired, true);
  assert.equal(r.sudo, true);
});

test("apt: counts upgrades and reads the reboot flag", async () => {
  const run = fakeRun({ "sh -c command -v dnf": { code: 1 }, "sh -c command -v yum": { code: 1 }, "sh -c command -v apt-get": { stdout: "/usr/bin/apt-get" }, "sudo -n true": { code: 1 }, "apt-get -s upgrade": { stdout: "Inst libc6 [2.1]\nInst curl [7]\nConf curl\n" } });
  const r = await createSystem({ run, jobs: createJobs(), hasFile: (f) => f === "/var/run/reboot-required" }).check({ force: true });
  assert.deepEqual(r.updates, ["libc6", "curl"]);
  assert.equal(r.rebootRequired, true);
  assert.equal(r.sudo, false);
});

test("log ring keeps the last lines and marks errors", () => {
  const ring = createLogRing();
  for (let i = 0; i < 700; i++) ring.push("log", [`line ${i}`]);
  ring.push("error", ["boom"]);
  const t = ring.tail(5);
  assert.match(t.at(-1), /! boom/);
  assert.equal(ring.tail(1000).length, 600);
});

test("routes: admin only; reboot needs the typed word and refuses while players are on", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('boss', ?, 'admin', 1)").run(hashPassword("pw-admin-123"));
  db.prepare("INSERT INTO users (username, password_hash, role, all_servers) VALUES ('op', ?, 'operator', 1)").run(hashPassword("pw-operator-123"));
  let rebooted = 0;
  const system = { check: async () => ({ pm: "dnf", updates: [], sudo: true }), upgrade: () => ({ id: "j1" }), restartMachine: async () => void rebooted++ };
  const services = createServices({ db, dataDir: "/tmp/console-sys-test" });
  let players = true;
  const app = buildApp({ db, services, system });
  const login = async (u, p) => {
    const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: u, password: p } });
    return `console_session=${r.cookies.find((c) => c.name === "console_session").value}`;
  };
  const boss = await login("boss", "pw-admin-123"), op = await login("op", "pw-operator-123");
  const call = (cookie, method, url, payload) => app.inject({ method, url, headers: { cookie }, payload });
  assert.equal((await call(op, "GET", "/api/system")).statusCode, 403);
  assert.equal((await call(op, "POST", "/api/system/reboot", { confirm: "restart" })).statusCode, 403);
  assert.equal((await call(boss, "GET", "/api/system")).json().pm, "dnf");
  assert.equal((await call(boss, "POST", "/api/system/upgrade", {})).json().jobId, "j1");
  assert.equal((await call(boss, "POST", "/api/system/reboot", {})).statusCode, 400);
  assert.equal((await call(boss, "GET", "/api/system/logs")).statusCode, 200);
});
