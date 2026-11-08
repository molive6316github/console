import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openDb, setSetting } from "../src/db.js";
import { createServices } from "../src/services.js";
import { createMonitor, uptimePercent, hostHistory } from "../src/monitor.js";
import { createScheduler } from "../src/scheduler.js";
import { createNotifier, validWebhook, maskWebhook } from "../src/notify.js";
import { createBackups } from "../src/backups.js";
import { parseCpu, cpuPercent, parseMem } from "../src/hostmetrics.js";

const addServer = (db, id, type = "dummy", target = {}) =>
  db.prepare("INSERT INTO servers (id, name, type, target) VALUES (?, ?, ?, ?)").run(id, id.toUpperCase(), type, JSON.stringify(target));

// ---- monitor + alerts -----------------------------------------------------------
function monitorFixture() {
  const db = openDb(":memory:");
  addServer(db, "mc");
  const sent = [];
  const notifier = { send: async (t) => void sent.push(t) };
  let status = "up";
  let t = 1_000_000;
  const monitor = createMonitor({ db, notifier, getStatus: async () => status, now: () => t, sampler: () => ({ cpu: 5, memUsed: 1, memTotal: 2, diskUsed: 1, diskTotal: 2, load1: 0.1 }) });
  return { db, sent, monitor, set: (s) => (status = s), advance: (ms) => (t += ms) };
}

test("alerts after two failed checks, once, then says when it's back", async () => {
  const f = monitorFixture();
  await f.monitor.tick(); // up: now it's supposed to stay up
  f.set("down");
  await f.monitor.tick();
  assert.equal(f.sent.length, 0, "one failed check is not an outage");
  await f.monitor.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0], /MC is DOWN/);
  await f.monitor.tick();
  await f.monitor.tick();
  assert.equal(f.sent.length, 1, "no repeat spam");
  f.advance(10 * 60_000);
  f.set("up");
  await f.monitor.tick();
  assert.equal(f.sent.length, 2);
  assert.match(f.sent[1], /back up/);
});

test("stopping from Console on purpose never alerts", async () => {
  const f = monitorFixture();
  await f.monitor.tick();
  f.db.prepare("UPDATE server_state SET expected = 'down' WHERE server_id = 'mc'").run(); // what runtime.perform('stop') does
  f.set("down");
  for (let i = 0; i < 5; i++) await f.monitor.tick();
  assert.deepEqual(f.sent, []);
});

test("a server that has never been seen running doesn't alert, and 'unknown' checks are ignored", async () => {
  const f = monitorFixture();
  f.set("down");
  for (let i = 0; i < 4; i++) await f.monitor.tick();
  assert.deepEqual(f.sent, []);
  const g = monitorFixture();
  await g.monitor.tick();
  g.set("unknown");
  for (let i = 0; i < 4; i++) await g.monitor.tick();
  assert.deepEqual(g.sent, []);
});

test("history: uptime percentage ignores unknown checks; host metrics are stored and downsampled", async () => {
  const f = monitorFixture();
  for (const s of ["up", "up", "down", "unknown"]) {
    f.set(s);
    await f.monitor.tick();
    f.advance(60_000);
  }
  assert.equal(uptimePercent(f.db, "mc", 0), 66.7);
  assert.equal(uptimePercent(f.db, "nobody", 0), null);
  for (let i = 0; i < 300; i++) f.db.prepare("INSERT OR REPLACE INTO host_metrics (ts, cpu, mem_used, mem_total, disk_used, disk_total, load1) VALUES (?, ?, 1, 2, 1, 2, 0)").run(10_000_000 + i, i % 100);
  assert.ok(hostHistory(f.db, 10_000_000, 120).length <= 120);
});

// ---- notifier -------------------------------------------------------------------
test("webhook goes out as JSON with both Discord and Slack fields; failures are audited, not thrown", async () => {
  const db = openDb(":memory:");
  const calls = [];
  const ok = createNotifier({ db, fetchImpl: async (url, init) => (calls.push({ url, body: JSON.parse(init.body) }), { ok: true }) });
  assert.equal((await ok.send("hi")).sent, false, "no webhook yet");
  setSetting(db, "alert_webhook", "https://discord.com/api/webhooks/1/abc");
  assert.equal((await ok.send("hello")).sent, true);
  assert.deepEqual(calls[0].body, { content: "hello", text: "hello" });
  const bad = createNotifier({ db, fetchImpl: async () => ({ ok: false, status: 404 }) });
  const r = await bad.send("x");
  assert.equal(r.sent, false);
  assert.equal(db.prepare("SELECT ok, action FROM audit_log").get().action, "alert");
});

test("webhook URLs: https only, no private or local targets; the stored URL is masked for display", () => {
  assert.equal(validWebhook("https://discord.com/api/webhooks/1/abc"), null);
  for (const u of ["http://discord.com/x", "https://localhost/x", "https://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x", "https://169.254.169.254/x", "https://[::1]/x", "ftp://x.com", "nope"]) {
    assert.ok(validWebhook(u), `should reject ${u}`);
  }
  const masked = maskWebhook("https://discord.com/api/webhooks/123456/SECRETTOKENabcd");
  assert.equal(masked.includes("SECRET"), false);
  assert.ok(masked.endsWith("abcd"));
});

// ---- scheduler ------------------------------------------------------------------
function schedFixture() {
  const db = openDb(":memory:");
  setSetting(db, "timezone", "UTC");
  addServer(db, "web", "dummy", { startsUp: true });
  const services = createServices({ db, dataDir: mkdtempSync(path.join(tmpdir(), "console-sched-")) });
  const scheduler = createScheduler({ db, runtime: services.runtime });
  const add = (cron, action = "restart", arg = null, sid = "web") =>
    Number(db.prepare("INSERT INTO schedules (server_id, action, arg, cron, created_by) VALUES (?, ?, ?, ?, 'test')").run(sid, action, arg, cron).lastInsertRowid);
  return { db, services, scheduler, add };
}

test("a due schedule runs exactly once per minute, others don't", async () => {
  const f = schedFixture();
  const due = f.add("0 4 * * *");
  const notDue = f.add("5 4 * * *");
  const at = Date.parse("2026-03-10T04:00:10Z");
  assert.equal(await f.scheduler.tick(at), 1);
  assert.equal(await f.scheduler.tick(at + 20_000), 0, "same minute again: no double run");
  assert.equal(await f.scheduler.tick(at + 24 * 3600_000), 1, "next day runs again");
  const row = f.db.prepare("SELECT * FROM schedules WHERE id = ?");
  assert.equal(row.get(due).last_status, "ok");
  assert.equal(row.get(notDue).last_status, null);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE username = ? AND action = 'restart' AND ok = 1").get(`schedule #${due}`).n, 2);
});

test("disabled schedules don't run; a schedule for a deleted server fails cleanly; a busy server is skipped", async () => {
  const f = schedFixture();
  const off = f.add("* * * * *");
  f.db.prepare("UPDATE schedules SET enabled = 0 WHERE id = ?").run(off);
  assert.equal(await f.scheduler.tick(Date.parse("2026-03-10T04:00:00Z")), 0);

  const orphan = f.add("* * * * *", "restart", null, "ghost");
  await f.scheduler.tick(Date.parse("2026-03-10T04:01:00Z"));
  assert.equal(f.db.prepare("SELECT last_status FROM schedules WHERE id = ?").get(orphan).last_status, "failed");

  f.services.runtime.busy.add("web");
  const live = f.add("* * * * *");
  await f.scheduler.tick(Date.parse("2026-03-10T04:02:00Z"));
  assert.equal(f.db.prepare("SELECT last_status FROM schedules WHERE id = ?").get(live).last_status, "skipped");
});

test("schedules follow the configured time zone", async () => {
  const f = schedFixture();
  setSetting(f.db, "timezone", "America/New_York");
  f.add("0 4 * * *");
  assert.equal(await f.scheduler.tick(Date.parse("2026-01-15T04:00:00Z")), 0); // 11pm in New York
  assert.equal(await f.scheduler.tick(Date.parse("2026-01-15T09:00:00Z")), 1); // 4am in New York
});

// ---- backups --------------------------------------------------------------------
function tree() {
  const base = mkdtempSync(path.join(tmpdir(), "console-bk-"));
  const root = path.join(base, "world");
  mkdirSync(path.join(root, "sub"), { recursive: true });
  writeFileSync(path.join(root, "a.txt"), "alpha");
  writeFileSync(path.join(root, "sub", "b.txt"), "beta");
  return { base, root, data: path.join(base, "data") };
}

test("backup makes a real tar.gz of the folder, keeps only the newest N, and lists/deletes safely", async () => {
  const { root, data } = tree();
  const bk = createBackups(data);
  const stamps = [0, 1, 2, 3].map((i) => new Date(Date.UTC(2026, 0, 1, 0, i, 0)));
  for (const d of stamps) await bk.create("mc", root, { keep: 3, now: d });
  const list = await bk.list("mc");
  assert.equal(list.length, 3);
  assert.ok(list[0].name > list[1].name, "newest first");
  assert.ok(!list.some((b) => b.name.startsWith("20260101T000000")), "oldest was pruned");
  const out = execFileSync("tar", ["-tzf", bk.pathFor("mc", list[0].name)]).toString();
  assert.match(out, /a\.txt/);
  assert.match(out, /sub\/b\.txt/);
  assert.equal(bk.pathFor("mc", "../../etc/passwd"), null);
  assert.equal(bk.pathFor("mc", "20260101T000000Z.tar.gz"), null);
  assert.equal(await bk.remove("mc", "../x"), false);
  assert.equal(await bk.remove("mc", list[2].name), true);
  assert.deepEqual(readdirSync(path.join(data, "backups", "mc")).filter((n) => n.endsWith(".partial")), []);
});

test("backup refuses a folder that contains Console's own data (it would back itself up forever)", async () => {
  const { base } = tree();
  const bk = createBackups(path.join(base, "world", "data"));
  mkdirSync(path.join(base, "world", "data"), { recursive: true });
  await assert.rejects(bk.create("mc", path.join(base, "world")), /own data folder/);
  await assert.rejects(bk.create("mc", "/no/such/dir"), /doesn't exist/);
});

// ---- host metrics parsing ---------------------------------------------------------
test("parses /proc/stat and /proc/meminfo", () => {
  const a = parseCpu("cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 1 1 1\n");
  const b = parseCpu("cpu  200 0 200 750 150 0 0 0 0 0\n");
  assert.equal(cpuPercent(a, b), 66.7); // 300 busy of 450 total
  assert.equal(cpuPercent(null, b), null);
  assert.equal(parseCpu("nonsense"), null);
  const m = parseMem("MemTotal:       8000000 kB\nMemFree: 100 kB\nMemAvailable:   2000000 kB\n");
  assert.deepEqual(m, { total: 8_192_000_000, used: 6_144_000_000 });
});
