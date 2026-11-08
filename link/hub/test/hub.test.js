import { test } from "node:test";
import assert from "node:assert/strict";
import { createHub } from "../hub.js";

async function boot(opts = {}) {
  let t = 1_000_000;
  const hub = createHub({ adminToken: "a".repeat(24), now: () => t, ...opts });
  await new Promise((r) => hub.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${hub.server.address().port}`;
  const call = (path, { method = "GET", token, body } = {}) => fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
  return { hub, call, tick: (ms) => (t += ms), admin: "a".repeat(24) };
}

test("hub: server push, public view, queued commands round-trip", async () => {
  const { hub, call, admin, tick } = await boot();
  const made = await call("/v1/admin/servers", { method: "POST", token: admin, body: { id: "halfsmp", name: "HalfSMP", isPublic: true } });
  assert.equal(made.status, 201);
  const key = made.json.key;
  assert.match(key, /^lk_/);
  assert.equal(hub.db.prepare("SELECT key_hash FROM servers").get().key_hash.includes(key), false, "key is stored hashed");

  assert.equal((await call("/v1/public/halfsmp")).json.online, false, "no data yet = offline");
  const push = await call("/v1/ingest", { method: "POST", token: key, body: { version: "26.3", max: 20, tps: 19.9, players: [{ name: "Max", uuid: "u" }, { name: "bad name!", uuid: "x" }] } });
  assert.equal(push.status, 200);
  const pub = (await call("/v1/public/halfsmp")).json;
  assert.deepEqual([pub.online, pub.players.online, pub.tps], [true, 1, 19.9]);
  assert.equal(pub.names, undefined, "names hidden unless the owner opts in");
  assert.deepEqual((await call("/v1/admin/servers/halfsmp", { token: admin })).json.names, ["Max"]);

  const q = await call("/v1/admin/servers/halfsmp/commands", { method: "POST", token: admin, body: { action: "whitelist-add", player: "Steve" } });
  assert.equal(q.status, 202);
  const next = await call("/v1/ingest", { method: "POST", token: key, body: { players: [] } });
  assert.deepEqual(next.json.commands, [{ id: q.json.id, cmd: "whitelist add Steve" }]);
  const again = await call("/v1/ingest", { method: "POST", token: key, body: { players: [], done: [{ id: q.json.id, result: "ok" }] } });
  assert.deepEqual(again.json.commands, [], "an acked command is never sent again");

  tick(120_000);
  assert.equal((await call("/v1/public/halfsmp")).json.online, false, "silent for 2 minutes = offline");
  hub.close();
});

test("hub: auth, allowlist, rate limit, key rotation", async () => {
  const { hub, call, admin, tick } = await boot({ perMinute: 3 });
  const { json: { key } } = await call("/v1/admin/servers", { method: "POST", token: admin, body: { id: "s1", name: "S1" } });
  assert.equal((await call("/v1/admin/servers")).status, 401);
  assert.equal((await call("/v1/admin/servers", { token: "nope" })).status, 401);
  assert.equal((await call("/v1/ingest", { method: "POST", token: "lk_wrong", body: {} })).status, 401);
  assert.equal((await call("/v1/public/s1")).status, 404, "private servers have no public page");
  for (const bad of [{ action: "stop" }, { action: "op", player: "a b" }, { action: "say", message: "/op me" }, { action: "say", message: "x\nop me" }, { action: "op", player: "x;stop" }]) {
    assert.equal((await call("/v1/admin/servers/s1/commands", { method: "POST", token: admin, body: bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await call("/v1/admin/servers/s1/commands", { method: "POST", token: admin, body: { action: "say", message: "hello" } })).status, 202);
  assert.deepEqual([1, 2, 3].map(() => 200), (await Promise.all([1, 2, 3].map(() => call("/v1/ingest", { method: "POST", token: key, body: {} })))).map((r) => r.status));
  assert.equal((await call("/v1/ingest", { method: "POST", token: key, body: {} })).status, 429);
  tick(61_000); // the limit follows the server, so rotating the key doesn't reset it
  const { json: r2 } = await call("/v1/admin/servers/s1/rotate", { method: "POST", token: admin });
  assert.equal((await call("/v1/ingest", { method: "POST", token: key, body: {} })).status, 401, "old key stops working");
  assert.equal((await call("/v1/ingest", { method: "POST", token: r2.key, body: {} })).status, 200);
  hub.close();
});
