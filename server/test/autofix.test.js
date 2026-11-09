import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "../src/db.js";
import { createJobs } from "../src/jobs.js";
import { createAutoFix, AGENTS } from "../src/autofix.js";

const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 40)); } return false; };

function setup() {
  const base = mkdtempSync(path.join(tmpdir(), "autofix-"));
  const dir = path.join(base, "srv"); mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "server.properties"), "server-port=25565\nmemory=99999\n");
  writeFileSync(path.join(dir, "bukkit.yml"), "ok: true\n");
  const db = openDb(path.join(base, "c.db"));
  const jobs = createJobs();
  let verdict = { ok: true, detail: "it works" };
  const scope = { name: "minecraft", target: "s1", dir, evidence: async () => "It dies: memory is too high.", verify: async () => verdict };
  const mk = (extra = {}) => createAutoFix({ db, dataDir: base, jobs, run: async () => ({ code: 0 }), scopes: { resolve: async () => scope }, agents: {}, ...extra });
  return { base, dir, db, scope, mk, setVerdict: (v) => (verdict = v), jobs };
}

// A "custom" agent is just a shell command, which is exactly what makes the agent swappable.
const FIX = `sed -i 's/memory=99999/memory=4096/' server.properties && echo "Lowered the memory setting so it fits."`;
const NOOP = `echo "I found nothing safe to change."`;

test("autofix: custom agent fixes the problem, change is listed, undo restores the original", async () => {
  const t = setup();
  const af = t.mk();
  af.configure({ enabled: true, agent: "custom", custom: FIX });
  const r = await af.fix({ scope: t.scope, title: "minecraft test", actor: "auto", incident: "crash:s1" });
  assert.ok(await until(async () => (await af.status()).history[0]?.state === "fixed"));
  const h = (await af.status()).history[0];
  assert.deepEqual(h.changed, [{ file: "server.properties", change: "edited" }]);
  assert.match(h.summary, /Lowered the memory/);
  assert.match(readFileSync(path.join(t.dir, "server.properties"), "utf8"), /memory=4096/);
  await af.undo(r.id);
  assert.match(readFileSync(path.join(t.dir, "server.properties"), "utf8"), /memory=99999/);
  assert.equal((await af.status()).history[0].state, "undone");
});

test("autofix: a fix that doesn't work is rolled back automatically", async () => {
  const t = setup();
  t.setVerdict({ ok: false, detail: "it crashed again" });
  const af = t.mk();
  af.configure({ enabled: true, agent: "custom", custom: `${FIX} && echo junk > extra.yml` });
  await af.fix({ scope: t.scope, title: "minecraft test", actor: "auto" });
  assert.ok(await until(async () => (await af.status()).history[0]?.state === "reverted"));
  assert.match(readFileSync(path.join(t.dir, "server.properties"), "utf8"), /memory=99999/, "edit reverted");
  assert.equal(existsSync(path.join(t.dir, "extra.yml")), false, "added file removed");
});

test("autofix: off by default, limits, no-change, and unknown agents are handled", async () => {
  const t = setup();
  const af = t.mk();
  await assert.rejects(() => af.fix({ scope: t.scope, title: "x", actor: "auto" }), /off/);
  af.configure({ enabled: true, agent: "custom", custom: NOOP, maxPerHour: 1 });
  await af.fix({ scope: t.scope, title: "x", actor: "auto" });
  assert.ok(await until(async () => (await af.status()).history[0]?.state === "nochange"));
  assert.ok(await until(async () => !af.busy()));
  await assert.rejects(() => af.fix({ scope: t.scope, title: "x", actor: "auto" }), /limit/);
  const manual = await af.fix({ scope: t.scope, title: "x", actor: "manual" }); // a person clicking is never rate-limited
  assert.ok(manual.id);
  const real = t.mk({ agents: AGENTS, which: async () => false });
  assert.throws(() => real.configure({ agent: "nope" }), /Unknown agent/);
  real.configure({ agent: "claude" });
  assert.equal((await real.status()).agents.find((a) => a.id === "claude").installed, false, "reports not installed instead of crashing");
});
