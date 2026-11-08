import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync, statSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFiles, FileError, MAX_EDIT_BYTES } from "../src/files.js";

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "console-files-"));
  const root = path.join(base, "srv");
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  writeFileSync(path.join(root, "server.properties"), "motd=hi\n");
  writeFileSync(path.join(root, "plugins", "a.yml"), "a: 1\n");
  writeFileSync(path.join(base, "secret.txt"), "TOP SECRET");
  return { base, root, files: createFiles(root) };
}
const rejects = (p, status) => assert.rejects(p, (e) => e instanceof FileError && (status === undefined || e.status === status));

test("lists folders first, then files", async () => {
  const { files } = fixture();
  const r = await files.list("");
  assert.deepEqual(r.entries.map((e) => [e.name, e.type]), [["plugins", "dir"], ["server.properties", "file"]]);
  assert.equal((await files.list("plugins")).entries[0].name, "a.yml");
});

test("reads and writes text; a write is atomic and keeps the file mode", async () => {
  const { root, files } = fixture();
  chmodSync(path.join(root, "server.properties"), 0o640);
  const f = await files.read("server.properties");
  assert.equal(f.content, "motd=hi\n");
  const w = await files.write("server.properties", "motd=changed\n", f.mtime);
  assert.equal(readFileSync(path.join(root, "server.properties"), "utf8"), "motd=changed\n");
  assert.equal(statSync(path.join(root, "server.properties")).mode & 0o777, 0o640);
  assert.ok(w.size > 0);
  assert.deepEqual(readdirSync(root).filter((n) => n.includes(".tmp")), []); // no leftovers
});

test("path traversal is refused in every spelling", async () => {
  const { files } = fixture();
  for (const p of ["../secret.txt", "plugins/../../secret.txt", "..", "a/../../x", "\0", "plugins/\0x"]) {
    await rejects(files.read(p));
    await rejects(files.write(p, "x"));
  }
  await rejects(files.list(".."));
  // an absolute path is just a path under the root, never the real filesystem root
  await rejects(files.read("/etc/passwd"), 404);
});

test("a symlink that points outside the folder can't be read, written through, or listed", async () => {
  const { base, root, files } = fixture();
  symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt"));
  symlinkSync(base, path.join(root, "outside"));
  await rejects(files.read("leak.txt"), 403);
  await rejects(files.write("leak.txt", "pwned", undefined), 403);
  await rejects(files.read("outside/secret.txt"), 403);
  await rejects(files.write("outside/new.txt", "x"), 403);
  assert.equal(readFileSync(path.join(base, "secret.txt"), "utf8"), "TOP SECRET");
  const names = (await files.list("")).entries.map((e) => e.name);
  assert.ok(!names.includes("leak.txt") && !names.includes("outside"));
});

test("a symlink that stays inside the folder is fine", async () => {
  const { root, files } = fixture();
  symlinkSync(path.join(root, "server.properties"), path.join(root, "alias.properties"));
  assert.equal((await files.read("alias.properties")).content, "motd=hi\n");
});

test("binary and oversized files are refused; folders can't be read as files", async () => {
  const { root, files } = fixture();
  writeFileSync(path.join(root, "world.dat"), Buffer.from([1, 2, 0, 3]));
  await rejects(files.read("world.dat"), 415);
  writeFileSync(path.join(root, "huge.log"), "x".repeat(MAX_EDIT_BYTES + 1));
  await rejects(files.read("huge.log"), 413);
  await rejects(files.write("big.txt", "x".repeat(MAX_EDIT_BYTES + 1)), 413);
  await rejects(files.write("nul.txt", "a\0b"));
  await rejects(files.read("plugins"));
});

test("saving over a file that changed since it was opened is refused (no silent overwrite)", async () => {
  const { root, files } = fixture();
  const f = await files.read("server.properties");
  writeFileSync(path.join(root, "server.properties"), "motd=someone else\n");
  const later = new Date(Date.now() + 5000);
  (await import("node:fs")).utimesSync(path.join(root, "server.properties"), later, later);
  await rejects(files.write("server.properties", "mine", f.mtime), 409);
  assert.equal(readFileSync(path.join(root, "server.properties"), "utf8"), "motd=someone else\n");
});

test("new files can be created in existing folders only", async () => {
  const { root, files } = fixture();
  await files.write("plugins/b.yml", "b: 2\n");
  assert.equal(readFileSync(path.join(root, "plugins", "b.yml"), "utf8"), "b: 2\n");
  await rejects(files.write("nope/dir/c.yml", "x"), 404);
  await rejects(files.write("", "x"));
});

test("a missing root gives a clear error", () => {
  assert.throws(() => createFiles("/definitely/not/here"), /doesn't exist/);
});
