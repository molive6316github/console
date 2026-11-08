import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const TICKS = 100; // Linux CLK_TCK is 100 on everything we run on
const KEEP = 360; // 1 hour at one sample per 10 s

const num = (s) => Number.parseFloat(s);

// "TPS from last 1m, 5m, 15m: 20.0, 19.98, *20.0" (Paper/Purpur) or "Average time per tick: 3.2ms" (vanilla `tick query`).
export function parseTps(text) {
  const clean = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/§./g, "");
  const lines = clean.split("\n").reverse();
  for (const l of lines) {
    const m = /TPS from last[^:]*:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/i.exec(l);
    if (m) return { tps: Math.min(20, num(m[1])), tps5: Math.min(20, num(m[2])), tps15: Math.min(20, num(m[3])) };
  }
  for (const l of lines) {
    const m = /Average time per tick:\s*([\d.]+)\s*ms/i.exec(l);
    if (m) {
      const ms = num(m[1]);
      return { tps: ms > 0 ? Math.min(20, Math.round((1000 / ms) * 100) / 100) : 20, mspt: ms };
    }
  }
  return null;
}

async function stat(procRoot, pid) {
  try {
    const raw = await readFile(path.join(procRoot, String(pid), "stat"), "utf8");
    const end = raw.lastIndexOf(")");
    const f = raw.slice(end + 2).split(" "); // f[0] is state
    return { ppid: Number(f[1]), ticks: Number(f[11]) + Number(f[12]), comm: raw.slice(raw.indexOf("(") + 1, end) };
  } catch {
    return null;
  }
}

// The java process under the tmux pane: walk the pane's children until we find "java".
export async function findJava(rootPid, procRoot = "/proc") {
  let names;
  try { names = (await readdir(procRoot)).filter((n) => /^\d+$/.test(n)); } catch { return null; }
  const kids = new Map();
  const info = new Map();
  for (const n of names) {
    const s = await stat(procRoot, n);
    if (!s) continue;
    info.set(Number(n), s);
    if (!kids.has(s.ppid)) kids.set(s.ppid, []);
    kids.get(s.ppid).push(Number(n));
  }
  const queue = [Number(rootPid)];
  const seen = new Set();
  while (queue.length) {
    const p = queue.shift();
    if (seen.has(p)) continue;
    seen.add(p);
    if (info.get(p)?.comm === "java") return p;
    queue.push(...(kids.get(p) ?? []));
  }
  return null;
}

async function rssMb(procRoot, pid) {
  try {
    const m = /VmRSS:\s+(\d+)\s*kB/.exec(await readFile(path.join(procRoot, String(pid), "status"), "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

// Remembers the last hour of CPU/RAM for each server. cpu is % of ONE core (200 = two cores busy).
export function createStats({ paneRun, procRoot = "/proc", now = () => Date.now(), cores = 1 }) {
  const series = new Map(); // id -> { points, last: {ticks, at}, pid, tps }

  async function sample(server) {
    const st = series.get(server.id) ?? { points: [], last: null, pid: null, tps: null, tpsAt: 0 };
    series.set(server.id, st);
    const session = server.target?.session;
    if (!session) return null;
    const t = now();
    const r = await paneRun(session).catch(() => null);
    const panePid = r && /^\d+$/.test(r.trim()) ? Number(r.trim()) : null;
    const pid = panePid ? await findJava(panePid, procRoot) : null;
    if (!pid) {
      st.pid = null;
      st.last = null;
      return null;
    }
    const s = await stat(procRoot, pid);
    if (!s) return null;
    let cpu = null;
    if (st.last && st.pid === pid && t > st.last.at) cpu = Math.round(((s.ticks - st.last.ticks) / TICKS / ((t - st.last.at) / 1000)) * 1000) / 10;
    st.pid = pid;
    st.last = { ticks: s.ticks, at: t };
    const pt = { t, cpu, ramMb: await rssMb(procRoot, pid) };
    if (cpu !== null) {
      st.points.push(pt);
      if (st.points.length > KEEP) st.points.shift();
    }
    return pt;
  }

  return {
    sample,
    view(id) {
      const st = series.get(id);
      return { cores, points: st?.points ?? [], tps: st?.tps ?? null, tpsAt: st?.tpsAt ?? 0 };
    },
    setTps(id, tps) {
      const st = series.get(id) ?? { points: [], last: null, pid: null, tps: null, tpsAt: 0 };
      series.set(id, st);
      st.tps = tps;
      st.tpsAt = now();
    },
    tpsAge(id) {
      const st = series.get(id);
      return st ? now() - st.tpsAt : Infinity;
    },
    forget(id) { series.delete(id); },
  };
}
