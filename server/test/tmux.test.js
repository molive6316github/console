import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import tmux from "../src/drivers/tmux.js";
import { TargetError } from "../src/drivers/exec.js";

const have = spawnSync("tmux", ["-V"]).status === 0;
const skip = have ? false : "tmux not installed";
const NAME = `consoletest${process.pid}`;
const target = { session: NAME, startCommand: `bash -c 'echo ready; while read l; do echo "got:$l"; if [ "$l" = stop ]; then exit 0; fi; done'`, stopTimeoutSec: 8, stopCommand: "stop" };

after(() => spawnSync("tmux", ["kill-session", "-t", `=${NAME}`]));
const until = async (fn, ms = 6000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
};

test("start, read logs, send a command, and graceful stop with a stop command", { skip }, async () => {
  assert.equal(await tmux.status(target), "down");
  assert.equal(await tmux.logs(target), "", "no session: empty logs, not an error");
  await tmux.start(target);
  assert.equal(await tmux.status(target), "up");
  assert.ok(await until(async () => (await tmux.logs(target)).includes("ready")), "sees startup output");

  await tmux.send(target, "hello world");
  assert.ok(await until(async () => (await tmux.logs(target)).includes("got:hello world")), "command reached the process");

  await tmux.send(target, "-weird; $(rm -rf /) 'quote' \"dq\"");
  assert.ok(await until(async () => (await tmux.logs(target)).includes(`got:-weird; $(rm -rf /) 'quote' "dq"`)), "special characters arrive literally");

  const t0 = Date.now();
  await tmux.stop(target); // sends "stop"; the script exits by itself, so no force-kill wait
  assert.equal(await tmux.status(target), "down");
  assert.ok(Date.now() - t0 < 6000, "graceful stop did not need the timeout");
  await assert.rejects(tmux.send(target, "x"), /isn't running/);
});

test("logs come back newest-last with the padding trimmed", { skip }, async () => {
  await tmux.start(target);
  await until(async () => (await tmux.logs(target)).includes("ready"));
  const out = await tmux.logs(target, 50);
  assert.ok(out.trimEnd().endsWith("ready"));
  assert.ok(!/\n\n$/.test(out));
  await tmux.stop(target);
});

test("a similar session name is never touched (exact match only)", { skip }, async () => {
  const other = { ...target, session: `${NAME}x` };
  await tmux.start(other);
  assert.equal(await tmux.status(target), "down");
  await tmux.stop(target);
  assert.equal(await tmux.status(other), "up");
  await tmux.stop(other);
});

test("send refuses multi-line, empty and oversized input", { skip }, async () => {
  await tmux.start(target);
  for (const bad of ["a\nb", "a\rb", "", "x".repeat(1001), 5, null]) await assert.rejects(tmux.send(target, bad), /single line/);
  await tmux.stop(target);
});

test("validate() cleans good targets and rejects bad ones", () => {
  const ok = tmux.validate({ session: "uhc", startCommand: "./run.sh", cwd: "/srv/uhc/", stopCommand: "stop", stopTimeoutSec: "20", extra: "dropped" });
  assert.deepEqual(ok, { session: "uhc", startCommand: "./run.sh", cwd: "/srv/uhc", stopCommand: "stop", stopTimeoutSec: 20 });
  for (const bad of [{}, { session: "bad name", startCommand: "x" }, { session: "a", startCommand: "" }, { session: "a", startCommand: "x", cwd: "relative" }, { session: "a", startCommand: "x", cwd: "/a/../b" }, { session: "a", startCommand: "x", cwd: "/" }, { session: "a", startCommand: "x", stopTimeoutSec: 9999 }, { session: "a", startCommand: "x\0y" }]) {
    assert.throws(() => tmux.validate(bad), TargetError, JSON.stringify(bad));
  }
});

test("a crashed server stays readable: shows stopped, keeps its output and exit code, and starts again", { skip }, async () => {
  const t = { session: `${NAME}crash`, startCommand: `bash -c 'echo about to die; exit 3'` };
  try {
    await tmux.start(t);
    assert.ok(await until(async () => (await tmux.status(t)) === "down"), "dead pane counts as down");
    const logs = await tmux.logs(t);
    assert.match(logs, /about to die/);
    assert.match(logs, /exited with code 3/);
    assert.equal((await tmux.exitInfo(t)).exitCode, 3);
    await tmux.start(t); // clears the dead session and launches again
    assert.ok(await until(async () => (await tmux.logs(t)).includes("about to die")));
    await tmux.stop(t);
    assert.equal(await tmux.exitInfo(t), null);
  } finally { spawnSync("tmux", ["kill-session", "-t", `=${t.session}`]); }
});
