import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDiscover } from "./discover.js";
import { createRuntime } from "./runtime.js";
import { createNotifier } from "./notify.js";
import { createMonitor } from "./monitor.js";
import { createScheduler } from "./scheduler.js";
import os from "node:os";
import { createJobs } from "./jobs.js";
import { createSetups } from "./setups/index.js";
import { getServer } from "./db.js";
import { createTerminal } from "./terminal.js";
import { createLinuxUsers } from "./linuxusers.js";
import { createMc } from "./mc/index.js";

// Wires the long-lived pieces together. Nothing runs on a timer until start() is called.
export function createServices({ db, dataDir, fetchImpl, now, sampler, discoverOptions = {}, setupOptions = {}, terminalOptions = {}, linuxOptions = {} } = {}) {
  const dir = dataDir ?? path.resolve("data");
  const runtime = createRuntime({ db, dataDir: dir });
  const extraRoots = (process.env.CONSOLE_SCAN_DIRS ?? "").split(":").filter((d) => d.startsWith("/"));
  const discover = createDiscover({
    db,
    dataDir: dir,
    selfDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
    extraRoots,
    ...discoverOptions,
  });
  const notifier = createNotifier({ db, fetchImpl });
  const monitor = createMonitor({ db, notifier, getStatus: (s) => runtime.status(s), now, sampler });
  const scheduler = createScheduler({ db, runtime, now });
  const jobs = createJobs();
  const mc = createMc({ runtime });
  const terminal = createTerminal({ db, ...terminalOptions });
  const linux = createLinuxUsers({ selfUser: setupOptions.user ?? os.userInfo().username, ...linuxOptions });
  const setups = createSetups({
    db,
    jobs,
    fetchImpl,
    appsDir: process.env.CONSOLE_APPS_DIR || path.join(os.homedir(), "servers"),
    caddy: {
      sitesDir: process.env.CONSOLE_CADDY_SITES || "/etc/caddy/sites",
      sitesRoot: process.env.CONSOLE_SITES_ROOT || "/srv/sites",
      caddyfile: process.env.CONSOLE_CADDYFILE || "/etc/caddy/Caddyfile",
    },
    publicIp: process.env.CONSOLE_PUBLIC_IP || "",
    startServer: (id, actor) => runtime.perform(getServer(db, id), "start", actor),
    restartServer: (id, actor) => runtime.perform(getServer(db, id), "restart", actor),
    ...setupOptions,
  });
  return {
    runtime,
    discover,
    notifier,
    monitor,
    scheduler,
    jobs,
    setups,
    terminal,
    linux,
    mc,
    start({ monitorSec = 60 } = {}) {
      scheduler.start();
      if (monitorSec > 0) monitor.start(monitorSec * 1000);
    },
    stop() {
      terminal.closeAll("Console is shutting down");
      scheduler.stop();
      monitor.stop();
    },
  };
}
