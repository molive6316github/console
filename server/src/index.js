import path from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb, syncServers } from "./db.js";
import { ensureAdmin } from "./auth.js";
import { seedSettings } from "./seed.js";
import { buildApp } from "./app.js";
import { updater } from "./updater.js";
import { createServices } from "./services.js";
import { createLogRing } from "./system.js";

const logRing = createLogRing(); // keeps the last few hundred log lines so the dashboard can show them
logRing.capture();

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PORT = parseInt(process.env.PORT ?? "3000", 10);
// Loopback by default. Put a reverse proxy with HTTPS in front before exposing it.
const HOST = process.env.HOST ?? "127.0.0.1";
const DB_FILE = process.env.CONSOLE_DB ?? path.join(root, "data", "console.db");
const SERVERS_FILE = process.env.CONSOLE_SERVERS ?? path.join(root, "servers.json");

// Old versions wrote three fake demo servers on first run. If that file is still untouched, clear it out.
const isOldDemo = (text) => {
  try {
    const l = JSON.parse(text);
    return Array.isArray(l) && l.length === 3 && l.every((x) => x.type === "dummy" && ["demo-web", "demo-db", "demo-worker"].includes(x.id));
  } catch {
    return false;
  }
};
if (!existsSync(SERVERS_FILE)) {
  writeFileSync(SERVERS_FILE, "[]\n");
} else if (isOldDemo(readFileSync(SERVERS_FILE, "utf8"))) {
  writeFileSync(SERVERS_FILE, "[]\n");
  console.log("Removed the old fake demo servers.");
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

const seeded = seedSettings(db);
if (seeded.length) console.log(`Applied setup choices: ${seeded.join(", ")}`);

const loopback = ["127.0.0.1", "::1", "localhost"].includes(HOST);
if (!loopback && process.env.CONSOLE_SECURE_COOKIES !== "1") {
  console.warn(
    "WARNING: listening on a public address without HTTPS. Passwords and session cookies will\n" +
      "travel in cleartext. Put the Caddy reverse proxy in front (see deploy/), keep HOST=127.0.0.1,\n" +
      "and set CONSOLE_SECURE_COOKIES=1 and CONSOLE_TRUST_PROXY=1.\n"
  );
}

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const sha = await updater.current();
const version = sha ? `${pkg.version} (${sha})` : pkg.version;

const services = createServices({ db, dataDir: path.dirname(DB_FILE) });
const safeMode = process.env.CONSOLE_SAFE_MODE === "1";
const app = buildApp({
  db,
  services,
  safeMode,
  dataDir: path.dirname(DB_FILE),
  version,
  secureCookies: process.env.CONSOLE_SECURE_COOKIES === "1",
  logger: process.env.CONSOLE_LOG === "1",
  autoUpdateEveryMs: 10 * 60_000,
  logRing,
});

app.listen({ port: PORT, host: HOST }).then(
  () => console.log(`Console running at http://${HOST}:${PORT}`),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);

// Background work: status checks + alerts + host metrics (CONSOLE_MONITOR_SEC, 0 = off) and the scheduler.
const monitorSec = parseInt(process.env.CONSOLE_MONITOR_SEC ?? "60", 10);
import("./autoimport.js").then(({ autoImport }) => (safeMode ? null : autoImport({ db, discover: services.discover }))).then((r) => r && !r.skipped && console.log(`Found ${r.added.length} thing(s) already running and added them to the dashboard.`)).catch((e) => console.error("Auto-detect failed:", e.message));
services.start({ monitorSec: Number.isFinite(monitorSec) ? monitorSec : 60 });
if (safeMode) console.log("Safe mode: server editing, the file editor and commands are disabled.");

