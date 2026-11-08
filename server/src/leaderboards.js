import { promises as fs } from "node:fs";
import path from "node:path";

// Reads the numbers Minecraft already keeps: world/stats/<uuid>.json, usercache.json, and EssentialsX balances if present.
export const BOARDS = {
  playtime: { label: "Playtime", unit: "hours", pick: (s) => (s["minecraft:custom"]?.["minecraft:play_time"] ?? s["minecraft:custom"]?.["minecraft:play_one_minute"] ?? 0) / 72000, fmt: (v) => `${v.toFixed(1)} h` },
  deaths: { label: "Deaths", unit: "", pick: (s) => s["minecraft:custom"]?.["minecraft:deaths"] ?? 0, fmt: (v) => String(Math.round(v)) },
  mobkills: { label: "Mob kills", unit: "", pick: (s) => s["minecraft:custom"]?.["minecraft:mob_kills"] ?? 0, fmt: (v) => String(Math.round(v)) },
  playerkills: { label: "Player kills", unit: "", pick: (s) => s["minecraft:custom"]?.["minecraft:player_kills"] ?? 0, fmt: (v) => String(Math.round(v)) },
  mined: { label: "Blocks mined", unit: "", pick: (s) => Object.values(s["minecraft:mined"] ?? {}).reduce((a, b) => a + b, 0), fmt: (v) => Math.round(v).toLocaleString("en-US") },
  walked: { label: "Distance travelled", unit: "km", pick: (s) => ["walk", "sprint", "swim", "fly", "aviate", "boat", "horse", "minecart"].reduce((a, k) => a + (s["minecraft:custom"]?.[`minecraft:${k}_one_cm`] ?? 0), 0) / 100000, fmt: (v) => `${v.toFixed(1)} km` },
  balance: { label: "Richest", unit: "", essentials: true, fmt: (v) => v.toLocaleString("en-US", { maximumFractionDigits: 2 }) },
};

const readJson = async (f) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return null; } };

export async function loadPlayers(root, level = "world") {
  const names = new Map();
  for (const e of (await readJson(path.join(root, "usercache.json"))) ?? []) if (e?.uuid && e?.name) names.set(String(e.uuid).toLowerCase(), e.name);
  const dir = path.join(root, level, "stats");
  const stats = new Map();
  try {
    for (const f of await fs.readdir(dir)) {
      if (!/^[0-9a-f-]{32,36}\.json$/i.test(f)) continue;
      const j = await readJson(path.join(dir, f));
      if (j?.stats) stats.set(f.slice(0, -5).toLowerCase(), j.stats);
    }
  } catch { /* no stats yet */ }
  return { names, stats };
}

async function balances(root) {
  const out = new Map();
  const dir = path.join(root, "plugins", "Essentials", "userdata");
  try {
    for (const f of await fs.readdir(dir)) {
      if (!/\.yml$/.test(f)) continue;
      const text = await fs.readFile(path.join(dir, f), "utf8");
      const m = /^money:\s*['"]?(-?[\d.]+)/m.exec(text);
      const n = /^last-account-name:\s*['"]?([A-Za-z0-9_]{1,16})/m.exec(text);
      if (m) out.set(f.slice(0, -4).toLowerCase(), { value: Number(m[1]), name: n?.[1] });
    }
  } catch { /* no Essentials */ }
  return out;
}

export async function computeBoard(root, level, board, { limit = 10, exclude = [] } = {}) {
  const def = BOARDS[board];
  if (!def) return null;
  const hide = new Set(exclude.map((x) => String(x).toLowerCase()));
  const { names, stats } = await loadPlayers(root, level);
  let rows = [];
  if (def.essentials) {
    for (const [uuid, b] of await balances(root)) rows.push({ name: names.get(uuid) ?? b.name ?? uuid.slice(0, 8), value: b.value });
  } else {
    for (const [uuid, s] of stats) rows.push({ name: names.get(uuid) ?? uuid.slice(0, 8), value: def.pick(s) });
  }
  rows = rows.filter((r) => r.value > 0 && !hide.has(r.name.toLowerCase())).sort((a, b) => b.value - a.value).slice(0, Math.min(Math.max(limit, 1), 100));
  return { board, label: def.label, rows: rows.map((r, i) => ({ rank: i + 1, name: r.name, value: Math.round(r.value * 100) / 100, display: def.fmt(r.value) })) };
}
