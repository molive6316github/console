import { h, svg, api, lifecycle, bytes, duration } from "../ui.js";

const RANGES = [["1h", 1], ["6h", 6], ["24h", 24], ["7d", 168]];
const pct = (used, total) => (used != null && total ? (used / total) * 100 : null);

function lineChart(title, points, fmt) {
  const W = 600;
  const H = 120;
  const valid = points.filter((p) => p.v != null);
  const box = h("div", { class: "chart" });
  const last = valid.at(-1)?.v;
  const peak = valid.length ? Math.max(...valid.map((p) => p.v)) : null;
  const avg = valid.length ? valid.reduce((a, p) => a + p.v, 0) / valid.length : null;
  box.append(
    h("div", { class: "chart-head" }, h("strong", {}, title), h("span", { class: "muted" }, valid.length ? `now ${fmt(last)} · avg ${fmt(avg)} · peak ${fmt(peak)}` : "collecting data… (a point is added every minute)"))
  );
  if (valid.length < 2) return box;
  const t0 = valid[0].ts;
  const t1 = valid.at(-1).ts;
  const x = (t) => ((t - t0) / Math.max(t1 - t0, 1)) * W;
  const y = (v) => H - (Math.min(Math.max(v, 0), 100) / 100) * H;
  const d = valid.map((p, i) => `${i ? "L" : "M"}${x(p.ts).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  box.append(
    svg(
      "svg",
      { viewBox: `0 0 ${W} ${H + 18}`, class: "chartsvg", role: "img", "aria-label": `${title} over time` },
      [0, 50, 100].map((g) => svg("g", {}, svg("line", { x1: 0, x2: W, y1: y(g), y2: y(g), class: "grid" }), svg("text", { x: 4, y: y(g) + (g === 100 ? 11 : -3), class: "axis" }, `${g}%`))),
      svg("path", { d: `${d} L${x(t1)},${H} L${x(t0)},${H} Z`, class: "area" }),
      svg("path", { d, class: "line" }),
      svg("text", { x: 4, y: H + 14, class: "axis" }, new Date(t0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })),
      svg("text", { x: W - 4, y: H + 14, class: "axis end" }, new Date(t1).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }))
    )
  );
  return box;
}

function meter(label, value, detail) {
  const fill = h("div", { class: "fill" });
  fill.style.width = `${Math.min(Math.max(value ?? 0, 0), 100)}%`;
  return h("div", { class: "meter" }, h("div", { class: "chart-head" }, h("strong", {}, label), h("span", {}, value == null ? "-" : `${value.toFixed(0)}%`)), h("div", { class: `bar${value >= 90 ? " hot" : ""}` }, fill), h("small", { class: "muted" }, detail));
}

export function hostView(box) {
  const life = lifecycle();
  let hours = 24;
  const tiles = h("div", { class: "meters" });
  const charts = h("div", {});
  const info = h("p", { class: "muted" });
  const picker = h("div", { class: "tabs small" });

  function drawPicker() {
    picker.replaceChildren(...RANGES.map(([label, hrs]) => h("a", { class: `tab${hrs === hours ? " on" : ""}`, href: "#", onclick: (e) => (e.preventDefault(), (hours = hrs), drawPicker(), load()) }, label)));
  }

  async function load() {
    let r;
    try {
      r = await api(`/host?hours=${hours}`);
    } catch {
      return;
    }
    const c = r.current;
    info.textContent = `${r.host} · ${r.cores} CPU core${r.cores === 1 ? "" : "s"} · up ${duration(r.uptimeSec)} · ${r.servers} server${r.servers === 1 ? "" : "s"} managed`;
    tiles.replaceChildren(
      meter("CPU", c?.cpu ?? null, c?.load1 != null ? `load ${c.load1.toFixed(2)}` : ""),
      meter("Memory", pct(c?.mem_used, c?.mem_total), c ? `${bytes(c.mem_used)} of ${bytes(c.mem_total)}` : ""),
      meter("Disk", pct(c?.disk_used, c?.disk_total), c ? `${bytes(c.disk_used)} of ${bytes(c.disk_total)}` : "")
    );
    const f1 = (v) => `${v.toFixed(0)}%`;
    charts.replaceChildren(
      lineChart("CPU", r.history.map((p) => ({ ts: p.ts, v: p.cpu })), f1),
      lineChart("Memory", r.history.map((p) => ({ ts: p.ts, v: pct(p.mem_used, p.mem_total) })), f1),
      lineChart("Disk", r.history.map((p) => ({ ts: p.ts, v: pct(p.disk_used, p.disk_total) })), f1)
    );
  }

  drawPicker();
  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Host"), picker), info, tiles, charts);
  load();
  life.every(load, 30_000);
  return () => life.stop();
}
