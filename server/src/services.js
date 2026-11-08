import path from "node:path";
import { createRuntime } from "./runtime.js";
import { createNotifier } from "./notify.js";
import { createMonitor } from "./monitor.js";
import { createScheduler } from "./scheduler.js";

// Wires the long-lived pieces together. Nothing runs on a timer until start() is called.
export function createServices({ db, dataDir, fetchImpl, now, sampler } = {}) {
  const runtime = createRuntime({ db, dataDir: dataDir ?? path.resolve("data") });
  const notifier = createNotifier({ db, fetchImpl });
  const monitor = createMonitor({ db, notifier, getStatus: (s) => runtime.status(s), now, sampler });
  const scheduler = createScheduler({ db, runtime, now });
  return {
    runtime,
    notifier,
    monitor,
    scheduler,
    start({ monitorSec = 60 } = {}) {
      scheduler.start();
      if (monitorSec > 0) monitor.start(monitorSec * 1000);
    },
    stop() {
      scheduler.stop();
      monitor.stop();
    },
  };
}
