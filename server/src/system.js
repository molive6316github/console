import { existsSync } from "node:fs";
import os from "node:os";
import { run as defaultRun } from "./drivers/exec.js";
import { detectPm } from "./setups/common.js";

// Keeping the machine itself patched, from the browser. Everything is a fixed command through passwordless sudo
// (opc has it on Oracle); nothing here takes input from the web.
const RING = 600;

export function createLogRing() {
  const lines = [];
  const push = (kind, args) => {
    const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack || a.message : JSON.stringify(a))).join(" ");
    for (const l of text.split("\n")) {
      lines.push(`${new Date().toISOString().slice(11, 19)} ${kind === "error" ? "! " : ""}${l}`);
      if (lines.length > RING) lines.shift();
    }
  };
  let on = false;
  return {
    capture() {
      if (on) return;
      on = true;
      for (const k of ["log", "info", "warn", "error"]) {
        const orig = console[k].bind(console);
        console[k] = (...a) => {
          orig(...a);
          push(k === "error" || k === "warn" ? "error" : "log", a);
        };
      }
    },
    push,
    tail: (n = 300) => lines.slice(-n),
  };
}

export function createSystem({ run = defaultRun, jobs, reboot = null, hasFile = existsSync, uptime = () => os.uptime() } = {}) {
  let cached = null;

  async function sudoOk() {
    return (await run("sudo", ["-n", "true"]).catch(() => ({ code: 1 }))).code === 0;
  }

  async function check({ force = false } = {}) {
    if (!force && cached && Date.now() - cached.at < 60_000) return cached.data;
    const pm = await detectPm(run);
    const out = { pm, sudo: await sudoOk(), updates: [], rebootRequired: false, uptimeSec: Math.round(uptime()) };
    if (pm === "apt-get") {
      const r = await run("apt-get", ["-s", "upgrade"], { timeout: 60_000 });
      out.updates = r.stdout.split("\n").filter((l) => l.startsWith("Inst ")).map((l) => l.split(" ")[1]);
      out.rebootRequired = hasFile("/var/run/reboot-required");
    } else if (pm) {
      const r = await run(pm, ["check-update", "-q"], { timeout: 120_000 }); // exit 100 = updates available
      if (r.code === 100) out.updates = r.stdout.split("\n").map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[\w.+-]+\.[\w_]+$/.test(n));
      const nr = await run("needs-restarting", ["-r"], { timeout: 30_000 }).catch(() => ({ code: 0 }));
      out.rebootRequired = nr.code === 1;
    }
    cached = { at: Date.now(), data: out };
    return out;
  }

  function upgrade(actor) {
    return jobs.start({ title: "Update the operating system", actor }, async (ctx) => {
      const pm = await detectPm(run);
      if (!pm) throw new Error("No supported package manager found (dnf, yum or apt-get).");
      if (!(await sudoOk())) throw new Error("Console needs passwordless sudo to do this. opc has it on Oracle.");
      if (pm === "apt-get") {
        await ctx.exec("sudo", ["-n", "apt-get", "update", "-qq"]);
        await ctx.exec("sudo", ["-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "-y", "-o", "Dpkg::Options::=--force-confold", "upgrade"]);
      } else {
        await ctx.exec("sudo", ["-n", pm, "-y", "upgrade"]);
      }
      cached = null;
      ctx.log("Done. If it says a restart is needed, use Restart machine when nobody is playing.");
      return {};
    });
  }

  async function restartMachine() {
    if (!(await sudoOk())) throw Object.assign(new Error("Console needs passwordless sudo to restart the machine."), { status: 400 });
    (reboot ?? (() => run("sudo", ["-n", "systemctl", "reboot"])))();
    return { ok: true };
  }

  return { check, upgrade, restartMachine };
}
