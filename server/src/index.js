import path from "node:path";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, syncServers } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { buildApp } from "./app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = parseInt(process.env.PORT ?? "3000", 10);
// Loopback by default. Put a reverse proxy with HTTPS in front before exposing it.
const HOST = process.env.HOST ?? "127.0.0.1";
const DB_FILE = process.env.CONSOLE_DB ?? path.join(root, "data", "console.db");
const SERVERS_FILE = process.env.CONSOLE_SERVERS ?? path.join(root, "servers.json");

const STARTER = [
  { id: "demo-web", name: "Demo Web (fake)", type: "dummy", target: { startsUp: true } },
  { id: "demo-db", name: "Demo DB (fake)", type: "dummy", target: { startsUp: false } },
  { id: "demo-worker", name: "Demo Worker (fake)", type: "dummy", target: { startsUp: true } },
];

if (!existsSync(SERVERS_FILE)) {
  writeFileSync(SERVERS_FILE, JSON.stringify(STARTER, null, 2) + "\n");
  console.log(`No servers.json found. Wrote a starter one with 3 fake servers: ${SERVERS_FILE}`);
  console.log("See servers.example.json for docker / systemd / tmux / http examples.\n");
}

const db = openDb(DB_FILE);
const { synced } = syncServers(db, SERVERS_FILE);
console.log(`Loaded ${synced} server(s) from ${SERVERS_FILE}`);

const admin = ensureAdmin(db);
if (admin) {
  console.log("\nFirst run: created admin account");
  console.log(`  username: ${admin.username}`);
  console.log(admin.generated ? `  password: ${admin.password}   (shown once, save it)\n` : "  password: from CONSOLE_ADMIN_PASSWORD\n");
}

const loopback = ["127.0.0.1", "::1", "localhost"].includes(HOST);
if (!loopback && process.env.CONSOLE_SECURE_COOKIES !== "1") {
  console.warn(
    "WARNING: listening on a public address without HTTPS. Passwords and session cookies will\n" +
      "travel in cleartext. Put the Caddy reverse proxy in front (see deploy/), keep HOST=127.0.0.1,\n" +
      "and set CONSOLE_SECURE_COOKIES=1 and CONSOLE_TRUST_PROXY=1.\n"
  );
}

const app = buildApp({
  db,
  secureCookies: process.env.CONSOLE_SECURE_COOKIES === "1",
  logger: process.env.CONSOLE_LOG === "1",
});

app.listen({ port: PORT, host: HOST }).then(
  () => console.log(`Console running at http://${HOST}:${PORT}`),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
