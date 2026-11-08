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
import { getServer, getSetting, setSetting } from "./db.js";
import { createStartup, restartCrons } from "./mc/startup.js";
import { getDriver } from "./drivers/index.js";
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
  let startupRef = null;
  const monitor = createMonitor({ db, notifier, getStatus: (s) => runtime.status(s), now, sampler, onCrash: (s) => startupRef?.onCrash(s, runtime.perform) });
  let mcRef = null;
  const scheduler = createScheduler({ db, runtime, now, runMc: (...a) => mcRef.scheduled(...a) });
  const jobs = createJobs();
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
  const mc = createMc({ runtime, fetchImpl, getToken: () => getSetting(db, "github_token", "") || "", getMeta: (id) => setups.metaOf(id),
    jobs,
    getJoin: () => ({ domain: getSetting(db, "join_domain", ""), srv: getSetting(db, "join_srv", "0") === "1", ip: process.env.CONSOLE_PUBLIC_IP || "" }),
    cfgGet: (id) => { try { return JSON.parse(getSetting(db, `mcgh.${id}`, "") || "null"); } catch { return null; } },
    cfgSet: (id, v) => setSetting(db, `mcgh.${id}`, JSON.stringify(v)),
    dataDir: dir,
  });
  mcRef = mc;
  const startup = createStartup({
    getServer: (id) => getServer(db, id),
    saveTarget: (id, target) => db.prepare("UPDATE servers SET target = ? WHERE id = ?").run(JSON.stringify(target), id),
    validateTarget: (type, target) => getDriver(type).validate(target),
    cfgGet: (id) => { try { return JSON.parse(getSetting(db, `mcstart.${id}`, "") || "null"); } catch { return null; } },
    cfgSet: (id, v) => setSetting(db, `mcstart.${id}`, JSON.stringify(v)),
    hostMemMb: () => Math.round(os.totalmem() / 1048576),
    setDaily: (id, hhmm) => {
      db.prepare("DELETE FROM schedules WHERE server_id = ? AND created_by = 'panel:restart'").run(id);
      if (!hhmm) return;
      const c = restartCrons(hhmm);
      const add = db.prepare("INSERT INTO schedules (server_id, action, arg, cron, enabled, created_by) VALUES (?, ?, ?, ?, 1, 'panel:restart')");
      add.run(id, "command", "say Server restarting in 5 minutes!", c.warn);
      add.run(id, "restart", null, c.go);
    },
    now: now ?? (() => Date.now()),
  });
  startupRef = startup;
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
    startup,
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
