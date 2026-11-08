import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, setSetting } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { buildApp } from "../src/app.js";
import { createServices } from "../src/services.js";
import { signRequest, createOffsite, OffsiteError } from "../src/offsite.js";

test("SigV4: AWS documented example (GET object with Range) gives the documented signature", () => {
  const h = signRequest({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", accessKey: "AKIAIOSFODNN7EXAMPLE", secretKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", now: new Date("2013-05-24T00:00:00Z"), payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", headers: { range: "bytes=0-9" } });
  assert.match(h.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test("offsite: validates input, uploads with signed streaming PUT, prunes old copies, never echoes the secret", async () => {
  const calls = [];
  const db = openDb(":memory:");
  const dir = mkdtempSync(path.join(os.tmpdir(), "off-"));
  const file = path.join(dir, "20260101T000000Z.tar.gz");
  writeFileSync(file, "world");
  const backups = { pathFor: (id, name) => (name === "20260101T000000Z.tar.gz" ? file : null) };
  const fetchImpl = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    if (init.method === "GET") return new Response(["<Key>p/s1/20250101T000000Z.tar.gz</Key>", "<Key>p/s1/20250102T000000Z.tar.gz</Key>", "<Key>p/s1/20260101T000000Z.tar.gz</Key>"].join(""), { status: 200 });
    if (init.body && init.body.getReader) await new Response(init.body).arrayBuffer();
    return new Response("", { status: 200 });
  };
  const o = createOffsite({ db, backups, fetchImpl });
  await assert.rejects(o.save({ endpoint: "http://insecure.example.com", bucket: "b", accessKey: "AAAAAAAA", secretKey: "SSSSSSSS" }), /https/);
  await assert.rejects(o.save({ endpoint: "https://10.0.0.1", bucket: "bb", accessKey: "AAAAAAAA", secretKey: "SSSSSSSS" }), /private/);
  const v = await o.save({ endpoint: "https://s3.example.com", region: "eu-1", bucket: "mybucket", accessKey: "AKIAEXAMPLE1", secretKey: "secret-secret", prefix: "p", keep: 2 });
  assert.deepEqual([v.configured, v.accessKeyTail], [true, "PLE1"]);
  assert.ok(!JSON.stringify(v).includes("secret-secret"));
  assert.ok(calls.some((c) => c.startsWith("PUT https://s3.example.com/mybucket/p/console-test.txt")));
  calls.length = 0;
  const r = await o.upload("s1", "20260101T000000Z.tar.gz");
  assert.equal(r.uploaded, true);
  assert.ok(calls.includes("PUT https://s3.example.com/mybucket/p/s1/20260101T000000Z.tar.gz"));
  assert.ok(calls.includes("DELETE https://s3.example.com/mybucket/p/s1/20250101T000000Z.tar.gz"), "oldest beyond keep=2 is removed");
  assert.equal(calls.filter((c) => c.startsWith("DELETE")).length, 1);
  await assert.rejects(o.upload("s1", "../../etc.tar.gz"), OffsiteError);
});

test("go-live: checklist reflects the server, fixes change real things", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "gl-"));
  const root = path.join(dataDir, "mcs");
  mkdirSync(path.join(root, "plugins"), { recursive: true });
  writeFileSync(path.join(root, "server.properties"), "server-port=25565\nonline-mode=true\nwhite-list=false\n");
  writeFileSync(path.join(root, "eula.txt"), "eula=true\n");
  writeFileSync(path.join(root, "plugins", "LuckPerms-5.jar"), "x");
  const db = openDb(":memory:");
  db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)").run("boss", hashPassword("pw-admin-123"), "admin", Date.now());
  db.prepare("INSERT INTO servers (id, name, type, target) VALUES (?, ?, 'tmux', ?)").run("s1", "S1", JSON.stringify({ session: "mc-s1", startCommand: "java -Xms2048M -Xmx2048M -jar server.jar nogui", cwd: root, stopCommand: "stop", filesRoot: root }));
  const app = buildApp({ db, services: createServices({ db, dataDir, runOptions: {} }), dataDir });
  const r = await app.inject({ method: "POST", url: "/api/login", payload: { username: "boss", password: "pw-admin-123" } });
  const c = `console_session=${r.cookies.find((x) => x.name === "console_session").value}`;
  const call = (m, u, p) => app.inject({ method: m, url: u, headers: { cookie: c }, payload: p });
  const g = (await call("GET", "/api/servers/s1/mc/golive")).json();
  const by = Object.fromEntries(g.checks.map((x) => [x.id, x]));
  assert.equal(by.eula.state, "ok");
  assert.equal(by.whitelist.state, "warn");
  assert.equal(by.backup.state, "bad");
  assert.equal(by.protect.state, "bad");
  assert.equal(by.ranks.state, "ok");
  assert.equal(g.summary.ready, false);

  assert.equal((await call("POST", "/api/servers/s1/mc/golive/fix", { id: "whitelist" })).statusCode, 200);
  assert.match(readFileSync(path.join(root, "server.properties"), "utf8"), /white-list=true/);
  assert.equal((await call("POST", "/api/servers/s1/mc/golive/fix", { id: "backup" })).statusCode, 200);
  assert.equal(db.prepare("SELECT count(*) AS n FROM schedules WHERE server_id='s1' AND action='mc-backup'").get().n, 1);
  assert.equal((await call("POST", "/api/servers/s1/mc/golive/fix", { id: "daily" })).statusCode, 200);
  assert.equal((await call("POST", "/api/servers/s1/mc/golive/fix", { id: "nope" })).statusCode, 400);
  const g2 = (await call("GET", "/api/servers/s1/mc/golive")).json();
  const by2 = Object.fromEntries(g2.checks.map((x) => [x.id, x]));
  assert.deepEqual([by2.whitelist.state, by2.backup.state, by2.daily.state], ["ok", "ok", "ok"]);
});
