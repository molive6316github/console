import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { upsertDns } from "../../scripts/cf-dns.mjs";

// A tiny fake of the parts of the Cloudflare API the helper uses.
const GOOD = "good-token-123";
let server;
let base;
let records;
let requests;

function reply(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
const ok = (result) => ({ success: true, errors: [], result });

before(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${GOOD}`) {
      return reply(res, 403, { success: false, errors: [{ code: 10000, message: "Authentication error" }] });
    }
    const url = new URL(req.url, "http://x");
    const p = url.pathname.replace("/client/v4", "");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "GET" && p === "/zones") {
        const n = url.searchParams.get("name");
        return reply(res, 200, ok(n === "example.com" ? [{ id: "z1", name: "example.com" }] : []));
      }
      if (req.method === "GET" && p === "/zones/z1/dns_records") {
        const { searchParams: q } = url;
        return reply(res, 200, ok(records.filter((r) => r.type === q.get("type") && r.name === q.get("name"))));
      }
      if (req.method === "POST" && p === "/zones/z1/dns_records") {
        if (records.some((r) => r.type === "CNAME" && r.name === body.name)) {
          return reply(res, 400, { success: false, errors: [{ code: 81053, message: "A CNAME record with that host already exists." }] });
        }
        records.push({ id: `r${records.length + 1}`, proxied: false, ...body });
        return reply(res, 200, ok(body));
      }
      const m = /^\/zones\/z1\/dns_records\/(\w+)$/.exec(p);
      if (req.method === "PATCH" && m) {
        Object.assign(records.find((r) => r.id === m[1]), body);
        return reply(res, 200, ok(body));
      }
      reply(res, 404, { success: false, errors: [{ message: "not found" }] });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/client/v4`;
});
after(() => server.close());

const reset = () => {
  records = [];
  requests = [];
};
const call = (over = {}) => upsertDns({ name: "console.example.com", ip: "203.0.113.10", token: GOOD, base, ...over });

test("creates an A record, finding the parent zone for a subdomain", async () => {
  reset();
  const r = await call();
  assert.equal(r.action, "created");
  assert.equal(r.zone, "example.com");
  assert.deepEqual(
    records.map((x) => [x.type, x.name, x.content, x.proxied]),
    [["A", "console.example.com", "203.0.113.10", false]]
  );
});

test("running it again changes nothing", async () => {
  reset();
  await call();
  const again = await call();
  assert.equal(again.action, "unchanged");
  assert.equal(records.length, 1);
});

test("updates the record when the IP changes", async () => {
  reset();
  await call();
  const r = await call({ ip: "198.51.100.7" });
  assert.equal(r.action, "updated");
  assert.equal(records.length, 1);
  assert.equal(records[0].content, "198.51.100.7");
});

test("works for the apex domain and for IPv6 (AAAA)", async () => {
  reset();
  assert.equal((await call({ name: "example.com" })).action, "created");
  assert.equal((await call({ ip: "2001:db8::1" })).type, "AAAA");
});

test("a bad token gives a clear error and never leaks the token", async () => {
  reset();
  await assert.rejects(call({ token: "wrong-token-xyz" }), (e) => {
    assert.match(e.message, /Authentication error/);
    assert.equal(e.message.includes("wrong-token-xyz"), false);
    return true;
  });
});

test("a domain that isn't on the account says so", async () => {
  reset();
  await assert.rejects(call({ name: "console.other.org" }), /No Cloudflare zone found for console\.other\.org/);
});

test("an existing CNAME at that name surfaces Cloudflare's message", async () => {
  reset();
  records.push({ id: "c1", type: "CNAME", name: "console.example.com", content: "x.example.net" });
  await assert.rejects(call(), /CNAME record with that host already exists/);
});

test("rejects bad hostnames and IPs before making any request", async () => {
  reset();
  await assert.rejects(call({ name: "not a host" }), /not a valid hostname/);
  await assert.rejects(call({ name: "x.example.com; rm -rf /" }), /not a valid hostname/);
  await assert.rejects(call({ ip: "999.1.1.1" }), /not a valid IP/);
  await assert.rejects(call({ ip: "1.2.3" }), /not a valid IP/);
  await assert.rejects(call({ token: "" }), /No Cloudflare API token/);
  assert.equal(requests.length, 0);
});

test("CLI works end to end and reads the token from the environment", async () => {
  reset();
  const run = (env) =>
    new Promise((resolve) =>
      execFile(
        "node",
        ["scripts/cf-dns.mjs", "console.example.com", "203.0.113.10"],
        { env: { ...process.env, CF_API_BASE: base, ...env } },
        (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })
      )
    );
  const good = await run({ CF_API_TOKEN: GOOD });
  assert.equal(good.code, 0);
  assert.match(good.stdout, /created A record console\.example\.com -> 203\.0\.113\.10 \(zone example\.com, DNS only\)/);
  const bad = await run({ CF_API_TOKEN: "nope" });
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /Authentication error/);
});
