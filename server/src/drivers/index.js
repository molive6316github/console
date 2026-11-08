import dummy from "./dummy.js";
import docker from "./docker.js";
import http from "./http.js";
import systemd from "./systemd.js";
import tmux from "./tmux.js";

// Every driver implements:
//   status(target, ctx)  -> "up" | "down" | "unknown"
//   start(target, ctx), stop(target, ctx), restart(target, ctx)
//   logs(target, lines, ctx) -> string
//   validate(target) -> cleaned target (throws TargetError). Used when servers are added in the UI.
//   send(target, text)   optional, types a line into the server (tmux)
//   supports             optional { logs, send }; logs defaults to true
// To add a new server type, drop a file in this folder and register it below.
const drivers = Object.fromEntries([dummy, docker, http, systemd, tmux].map((d) => [d.type, d]));

export function getDriver(type) {
  const d = drivers[type];
  if (!d) throw new Error(`Unknown driver type: ${type}`);
  return d;
}

export const driverTypes = Object.keys(drivers);

export function driverCaps(type) {
  const d = getDriver(type);
  return { logs: d.supports?.logs !== false, send: Boolean(d.send) };
}
