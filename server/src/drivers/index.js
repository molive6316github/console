import dummy from "./dummy.js";
import docker from "./docker.js";
import http from "./http.js";
import systemd from "./systemd.js";
import tmux from "./tmux.js";

// Every driver implements:
//   status(target, ctx)  -> "up" | "down" | "unknown"
//   start(target, ctx), stop(target, ctx), restart(target, ctx)
//   logs(target, lines)  -> string   (stubbed in v0.1, not exposed over the API yet)
// To add a new server type, drop a file in this folder and register it below.
const drivers = Object.fromEntries([dummy, docker, http, systemd, tmux].map((d) => [d.type, d]));

export function getDriver(type) {
  const d = drivers[type];
  if (!d) throw new Error(`Unknown driver type: ${type}`);
  return d;
}

export const driverTypes = Object.keys(drivers);
