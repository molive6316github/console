// Draws the 16x16 block textures used by the panel theme. All original: made from seeded noise, no game assets.
// Run: node scripts/gen-textures.mjs  (output is committed, so builds don't need this)
import { deflateSync, crc32 } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = new URL("../web/src/panel/tex/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rngFor = (seed) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

function png(name, px) {
  const raw = Buffer.alloc(16 * (1 + 16 * 4));
  for (let y = 0; y < 16; y++) {
    raw[y * 65] = 0;
    for (let x = 0; x < 16; x++) { const [r, g, b] = px[y][x]; raw.set([r, g, b, 255], y * 65 + 1 + x * 4); }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16, 0); ihdr.writeUInt32BE(16, 4); ihdr.set([8, 6, 0, 0, 0], 8);
  writeFileSync(OUT + name + ".png", Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]));
}
const grid = (fn) => Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => fn(x, y)));
const pick = (pal, r) => hex(pal[Math.floor(r() * pal.length)]);
const shift = ([r, g, b], d) => [r + d, g + d, b + d].map((v) => Math.max(0, Math.min(255, v)));

// blotchy noise: pick per 2x2 cell most of the time so it reads as texture, not static
const blotchy = (pal, seed) => { const r = rngFor(seed); const cell = grid(() => pick(pal, r)); return grid((x, y) => (r() < 0.35 ? pick(pal, r) : cell[y >> 1 << 1][x >> 1 << 1])); };

const DIRT = ["#8a5a3c", "#7a4e32", "#96653f", "#6d452c"];
const dirt = () => { const r = rngFor(7); const g = blotchy(DIRT, 11); for (let i = 0; i < 10; i++) g[Math.floor(r() * 16)][Math.floor(r() * 16)] = hex(r() < 0.5 ? "#59391f" : "#a9794f"); return g; };
png("dirt", dirt());

const GRASS = ["#4f9a32", "#5aa83a", "#66b544", "#468a2b"];
png("grass_top", blotchy(GRASS, 23));
{
  const r = rngFor(31); const d = dirt(); const gt = blotchy(GRASS, 29);
  const drip = Array.from({ length: 16 }, () => 3 + Math.floor(r() * 3)); // grass overhang 3..5 rows
  png("grass_side", grid((x, y) => (y < drip[x] ? shift(gt[y][x], y >= 3 ? -10 : 0) : d[y][x])));
}
{ const g = blotchy(["#7d7d7d", "#8a8a8a", "#707070", "#939393"], 41); const r = rngFor(43); for (let i = 0; i < 8; i++) g[Math.floor(r() * 16)][Math.floor(r() * 16)] = hex("#5f5f5f"); png("stone", g); }
{ const r = rngFor(53); const base = blotchy(["#3a3a40", "#323238", "#44444b", "#2b2b30"], 51); png("deepslate", grid((x, y) => (y % 5 === 2 && r() < 0.5 ? shift(base[y][x], 10) : base[y][x]))); }
{
  const r = rngFor(61);
  png("planks", grid((x, y) => {
    const row = y >> 2; const edge = y % 4 === 3; const off = (row % 2) * 8; const joint = (x + off) % 16 === 0;
    let c = hex(["#a47e4b", "#9a7344", "#b08852"][(row + (((x + off) >> 3) % 2)) % 3]);
    if (edge || joint) c = hex("#6e5230");
    else if (r() < 0.18) c = shift(c, r() < 0.5 ? -14 : 12);
    return c;
  }));
}
{
  const r = rngFor(71); const seeds = Array.from({ length: 9 }, () => [r() * 16, r() * 16, 100 + Math.floor(r() * 70)]);
  const own = (x, y) => { let best = 0, bd = 1e9, d2 = 1e9; seeds.forEach(([sx, sy], i) => { const d = Math.min(Math.abs(sx - x), 16 - Math.abs(sx - x)) ** 2 + Math.min(Math.abs(sy - y), 16 - Math.abs(sy - y)) ** 2; if (d < bd) { d2 = bd; bd = d; best = i; } else if (d < d2) d2 = d; }); return [best, d2 - bd]; };
  png("cobble", grid((x, y) => { const [i, gap] = own(x, y); const v = seeds[i][2]; return gap < 2.2 ? [58, 58, 58] : [v, v, v]; }));
}
{ const g = blotchy(["#14101f", "#1b1530", "#0f0b1a", "#241a3d"], 81); const r = rngFor(83); for (let i = 0; i < 6; i++) g[Math.floor(r() * 16)][Math.floor(r() * 16)] = hex("#3a2a66"); png("obsidian", g); }
console.log("textures written to", OUT);
