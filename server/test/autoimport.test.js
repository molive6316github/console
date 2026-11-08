import { test } from "node:test";
import assert from "node:assert/strict";
import { openDb, listServers } from "../src/db.js";
import { autoImport } from "../src/autoimport.js";

const fake = () => ({
  tmux: async () => ({ ok: true, sessions: [{ name: "uhc", command: "java -jar x.jar", cwd: "/home/opc/uhc", managedBy: null }, { name: "plain", command: "", managedBy: null }, { name: "known", managedBy: "known" }, { name: "bad name!", managedBy: null }] }),
  docker: async () => ({ ok: true, containers: [{ name: "kuma", managedBy: null }, { name: "old", managedBy: "old" }] }),
  systemd: async () => ({ ok: true, units: [{ unit: "myapp.service", description: "My app", active: "active", vendor: false }, { unit: "sshd.service", active: "active", vendor: true }, { unit: "console.service", active: "active", vendor: false, self: true }, { unit: "dead.service", active: "inactive", vendor: false }] }),
});

test("first start adds what's running (once), skipping vendor services, Console itself and odd names", async () => {
  const db = openDb(":memory:");
  const r = await autoImport({ db, discover: fake() });
  assert.deepEqual(r.added.map((a) => a.id).sort(), ["kuma", "myapp", "plain", "uhc"]);
  const uhc = listServers(db).find((s) => s.id === "uhc");
  assert.equal(uhc.target.startCommand, "java -jar x.jar");
  assert.equal(uhc.target.cwd, "/home/opc/uhc");
  assert.match(listServers(db).find((s) => s.id === "plain").target.startCommand, /set the real start command/);
  assert.equal(listServers(db).find((s) => s.id === "myapp").target.unit, "myapp.service");
  // second run does nothing, and a deleted server stays deleted
  db.prepare("DELETE FROM servers WHERE id = 'kuma'").run();
  assert.equal((await autoImport({ db, discover: fake() })).skipped, true);
  assert.equal(listServers(db).some((s) => s.id === "kuma"), false);
});

test("a broken scanner doesn't stop the others, and id clashes get a suffix", async () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES ('uhc','x','dummy','{}','file')").run();
  const d = fake();
  d.docker = async () => { throw new Error("no docker"); };
  const r = await autoImport({ db, discover: d });
  assert.ok(r.added.some((a) => a.id === "uhc-2"));
  assert.ok(r.added.some((a) => a.id === "myapp"));
});
