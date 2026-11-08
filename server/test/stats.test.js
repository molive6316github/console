import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseTps, findJava, createStats } from "../src/mc/stats.js";

function fakeProc(procs) {
  const root = mkdtempSync(path.join(tmpdir(), "proc-"));
  for (const [pid, p] of Object.entries(procs)) {
    mkdirSync(path.join(root, pid));
    // fields after ")": state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime
    writeFileSync(path.join(root, pid, "stat"), `${pid} (${p.comm}) S ${p.ppid} 1 1 0 0 0 0 0 0 0 ${p.utime ?? 0} ${p.stime ?? 0} 0 0\n`);
    writeFileSync(path.join(root, pid, "status"), `Name:\t${p.comm}\nVmRSS:\t${(p.rssMb ?? 100) * 1024} kB\n`);
  }
  return root;
}

test("TPS parsing: Paper, colored output, vanilla tick query, garbage", () => {
  assert.deepEqual(parseTps("[12:00:00 INFO]: TPS from last 1m, 5m, 15m: 19.8, 20.0, *20.0"), { tps: 19.8, tps5: 20, tps15: 20 });
  assert.deepEqual(parseTps("TPS from last 1m, 5m, 15m: \x1b[32m20.0\x1b[0m, 20.0, 20.0"), { tps: 20, tps5: 20, tps15: 20 });
  assert.equal(parseTps("Average time per tick: 100.0ms").tps, 10);
  assert.equal(parseTps("Average time per tick: 3.2ms").tps, 20, "capped at 20");
  assert.equal(parseTps("hello"), null);
  assert.equal(parseTps(null), null);
});

test("finds java under the tmux pane, not other processes", async () => {
  const root = fakeProc({ 10: { comm: "bash", ppid: 1 }, 11: { comm: "java", ppid: 10 }, 20: { comm: "java", ppid: 1 } });
  assert.equal(await findJava(10, root), 11);
  assert.equal(await findJava(99, root), null);
});

test("cpu and ram samples from /proc, ring buffer, restart resets baseline", async () => {
  const root = fakeProc({ 10: { comm: "bash", ppid: 1 }, 11: { comm: "java", ppid: 10, utime: 100, stime: 0, rssMb: 1500 } });
  let t = 1_000_000;
  const stats = createStats({ paneRun: async () => "10\n", procRoot: root, now: () => t, cores: 4 });
  const srv = { id: "a", target: { session: "mc-a" } };
  assert.equal((await stats.sample(srv)).cpu, null, "first sample has no baseline");
  writeFileSync(path.join(root, "11", "stat"), `11 (java) S 10 1 1 0 0 0 0 0 0 0 150 50 0 0\n`);
  t += 10_000;
  const p = await stats.sample(srv);
  assert.equal(p.cpu, 100 / 100 / 10 * 100, "100 ticks in 10s = 10% of a core");
  assert.equal(p.ramMb, 1500);
  assert.equal(stats.view("a").points.length, 1);
  assert.equal(stats.view("a").cores, 4);
  const down = createStats({ paneRun: async () => { throw new Error("no session"); }, procRoot: root });
  assert.equal(await down.sample(srv), null);
});
