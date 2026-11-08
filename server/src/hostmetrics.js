import { readFileSync, statfsSync } from "node:fs";
import os from "node:os";

// /proc/stat first line: cpu user nice system idle iowait irq softirq steal ...
export function parseCpu(text) {
  const line = text.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (n[3] ?? 0) + (n[4] ?? 0);
  const total = n.reduce((a, b) => a + b, 0);
  return { idle, total };
}

export function cpuPercent(prev, cur) {
  if (!prev || !cur || cur.total <= prev.total) return null;
  const busy = 1 - (cur.idle - prev.idle) / (cur.total - prev.total);
  return Math.round(Math.min(Math.max(busy, 0), 1) * 1000) / 10;
}

export function parseMem(text) {
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s+(\\d+) kB`, "m").exec(text);
    return m ? Number(m[1]) * 1024 : null;
  };
  const total = get("MemTotal");
  const avail = get("MemAvailable");
  if (total === null || avail === null) return null;
  return { total, used: total - avail };
}

// Reads the live numbers. CPU needs two samples, so the sampler keeps the previous one.
export function createSampler({ proc = "/proc", disk = "/" } = {}) {
  let prev = null;
  return function sample() {
    let cpu = null;
    let mem = { total: os.totalmem(), used: os.totalmem() - os.freemem() };
    try {
      const cur = parseCpu(readFileSync(`${proc}/stat`, "utf8"));
      cpu = cpuPercent(prev, cur);
      prev = cur;
    } catch { /* not Linux */ }
    try {
      mem = parseMem(readFileSync(`${proc}/meminfo`, "utf8")) ?? mem;
    } catch { /* fall back to os.* */ }
    let dsk = { total: null, used: null };
    try {
      const s = statfsSync(disk);
      dsk = { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
    } catch { /* ignore */ }
    return { cpu, memUsed: mem.used, memTotal: mem.total, diskUsed: dsk.used, diskTotal: dsk.total, load1: os.loadavg()[0], uptimeSec: Math.floor(os.uptime()), cores: os.cpus().length };
  };
}
