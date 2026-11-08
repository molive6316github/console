import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = path.join(root, "bin", "mxt-console.js");
const run = (args, env = {}) => spawnSync("node", [bin, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("package is publishable: public name, bin, files list covers the CLI, installer and built UI", () => {
  assert.equal(pkg.name, "mxt-console");
  assert.ok(!pkg.private);
  assert.equal(pkg.bin["mxt-console"], "bin/mxt-console.js");
  for (const f of ["bin", "server/src", "web/dist", "install.sh", "deploy"]) assert.ok(pkg.files.includes(f), f);
  assert.ok(!pkg.files.some((f) => /test|data|servers\.json$/.test(f)), "no tests, data or live server list shipped");
  assert.equal(pkg.scripts.prepack, "npm run build");
});

test("cli: --version, --help, unknown command and bad flags", () => {
  assert.equal(run(["--version"]).stdout.trim(), pkg.version);
  assert.match(run(["--help"]).stdout, /npx mxt-console/);
  const bad = run(["bogus"]);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Unknown command/);
  assert.equal(run(["--port", "abc"]).status, 2);
  assert.equal(run(["--port"]).status, 2);
  assert.equal(run(["start", "--nope"]).status, 2);
});

test("cli: start uses its own data folder and serves the dashboard", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "console-cli-"));
  const free = await new Promise((r) => { const s = http.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
  const child = spawn("node", [bin, "start", "--port", String(free), "--data", path.join(home, "d")], { env: { ...process.env, CONSOLE_ADMIN_PASSWORD: "Sup3r-long_pass" } });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      await new Promise((r) => setTimeout(r, 200));
      up = await fetch(`http://127.0.0.1:${free}/api/me`).then((r) => r.status === 401, () => false);
    }
    assert.ok(up, "server answered");
    assert.equal((await fetch(`http://127.0.0.1:${free}/`)).status, 200);
    assert.ok(existsSync(path.join(home, "d", "console.db")));
    assert.ok(existsSync(path.join(home, "d", "servers.json")));
  } finally {
    child.kill();
  }
});
