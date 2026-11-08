#!/usr/bin/env node
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const args = process.argv.slice(2);
const cmd = args[0] && !args[0].startsWith("-") ? args[0] : null;

const HELP = `mxt-console ${pkg.version}: a web dashboard for starting, stopping and watching your servers

  npx mxt-console                    run the dashboard on http://127.0.0.1:3000 (data in ~/.mxt-console)
  npx mxt-console start [--port N] [--host H] [--data DIR]
  sudo npx mxt-console install [...]  install as a service with HTTPS, firewall and a guided setup
                                       (same options as install.sh: --minecraft, --domain NAME, --reconfigure ...)
  sudo npx mxt-console docker [NAME]  create an isolated Console in a Docker container
  npx mxt-console --version | --help

First start prints the admin login once. Set CONSOLE_ADMIN_PASSWORD yourself to choose it.
Needs Node 22.13 or newer. More: https://github.com/molive6316github/console`;

function needNode() {
  const [maj, min] = process.versions.node.split(".").map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`mxt-console needs Node 22.13 or newer (you have ${process.versions.node}).`);
    process.exit(1);
  }
}

function takeFlag(name) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (!v || v.startsWith("-")) {
    console.error(`${name} needs a value`);
    process.exit(2);
  }
  args.splice(i, 2);
  return v;
}

function runInstaller(extra) {
  if (process.platform !== "linux") {
    console.error("The installer is for Linux servers (Oracle Linux, Ubuntu, Debian...). To just run the dashboard here: npx mxt-console");
    process.exit(1);
  }
  const script = path.join(root, "install.sh");
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const [bin, argv] = isRoot ? ["bash", [script, ...extra]] : ["sudo", ["bash", script, ...extra]];
  const r = spawnSync(bin, argv, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

if (args.includes("--version") || args.includes("-v") || cmd === "version") {
  console.log(pkg.version);
} else if (args.includes("--help") || args.includes("-h") || cmd === "help") {
  console.log(HELP);
} else if (cmd === "install") {
  runInstaller(args.slice(1));
} else if (cmd === "docker") {
  runInstaller(["--docker", ...args.slice(1)]);
} else if (cmd === null || cmd === "start") {
  if (cmd === "start") args.shift();
  const port = takeFlag("--port");
  const host = takeFlag("--host");
  const data = takeFlag("--data");
  if (args.length) {
    console.error(`Unknown option: ${args[0]}\n\n${HELP}`);
    process.exit(2);
  }
  needNode();
  if (port) {
    if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) {
      console.error("--port must be a number from 1 to 65535");
      process.exit(2);
    }
    process.env.PORT = port;
  }
  if (host) process.env.HOST = host;
  const dir = path.resolve(data ?? process.env.CONSOLE_DATA ?? path.join(os.homedir(), ".mxt-console"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  process.env.CONSOLE_DATA ??= dir;
  process.env.CONSOLE_DB ??= path.join(dir, "console.db");
  process.env.CONSOLE_SERVERS ??= path.join(dir, "servers.json");
  if (!existsSync(path.join(root, "web", "dist"))) {
    console.error("This copy has no built dashboard (web/dist). Reinstall the package, or run `npm run build` in a git checkout.");
    process.exit(1);
  }
  console.log(`mxt-console ${pkg.version}  data: ${dir}`);
  (await import("./supervise.js")).supervise();
} else {
  console.error(`Unknown command: ${cmd}\n\n${HELP}`);
  process.exit(2);
}
