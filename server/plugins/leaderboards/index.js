import { computeBoard, BOARDS } from "../../src/leaderboards.js";

const PAGE = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title.replace(/[<>&]/g, "")}</title><link rel="stylesheet" href="/api/plugins.css"><link rel="stylesheet" href="/x/leaderboards/board.css"></head><body><main><h1 id="t"></h1><nav id="tabs"></nav><table id="tbl"><tbody id="rows"></tbody></table></main><script src="/x/leaderboards/board.js"></script></body></html>`;
const CSS = `body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg,#0e1116);color:var(--text,#e6e9ef)}main{max-width:640px;margin:0 auto;padding:32px 16px}h1{margin:0 0 16px}nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}nav button{background:var(--panel,#171b22);color:inherit;border:1px solid var(--border,#2a3040);border-radius:8px;padding:6px 12px;cursor:pointer}nav button.on{border-color:var(--accent,#4ade80);color:var(--accent,#4ade80)}table{width:100%;border-collapse:collapse}td{padding:8px 10px;border-top:1px solid var(--border,#2a3040)}td:first-child{width:40px;color:var(--muted,#8b93a7)}td:last-child{text-align:right;font-variant-numeric:tabular-nums}`;
const JS = `(async()=>{const q=s=>document.getElementById(s);const cfg=await (await fetch("/x/leaderboards/boards.json")).json();q("t").textContent=cfg.title;document.title=cfg.title;
async function show(id){for(const b of q("tabs").children)b.className=b.dataset.id===id?"on":"";const r=await (await fetch("/x/leaderboards/board/"+id)).json();const tb=q("rows");tb.replaceChildren();
for(const row of r.rows){const tr=document.createElement("tr");for(const v of [row.rank,row.name,row.display]){const td=document.createElement("td");td.textContent=v;tr.append(td)}tb.append(tr)}
if(!r.rows.length){const tr=document.createElement("tr"),td=document.createElement("td");td.colSpan=3;td.textContent="Nothing here yet.";tr.append(td);tb.append(tr)}}
for(const b of cfg.boards){const e=document.createElement("button");e.textContent=b.label;e.dataset.id=b.id;e.onclick=()=>show(b.id);q("tabs").append(e)}
if(cfg.boards[0])show(cfg.boards[0].id)})();`;

export default function (ctx) {
  const level = async () => (await ctx.mc.live().catch(() => null))?.level ?? "world";
  const hidden = () => String(ctx.settings.get().hidden ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  ctx.route("GET", "/", { public: true }, async () => ({ type: "text/html; charset=utf-8", body: PAGE(ctx.settings.get().title || "Leaderboards") }));
  ctx.route("GET", "/board.css", { public: true }, async () => ({ type: "text/css", body: CSS }));
  ctx.route("GET", "/board.js", { public: true }, async () => ({ type: "text/javascript", body: JS }));
  ctx.route("GET", "/boards.json", { public: true }, async () => ({ body: { title: ctx.settings.get().title || "Leaderboards", boards: Object.entries(BOARDS).map(([id, b]) => ({ id, label: b.label })) } }));
  ctx.route("GET", "/board/:id", { public: true }, async (req) => {
    const server = ctx.mc.servers()[0];
    if (!server) return { rows: [] };
    const r = await computeBoard(server.root, await level(), req.params.id, { limit: ctx.settings.get().limit, exclude: hidden() });
    if (!r) return { status: 404, body: { error: "Unknown board" } };
    return { headers: { "Cache-Control": "public, max-age=30" }, body: r };
  });
}
