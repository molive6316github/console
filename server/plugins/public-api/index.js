import { timingSafeEqual } from "node:crypto";
import { computeBoard, BOARDS } from "../../src/leaderboards.js";

// Endpoints (all GET, JSON):
//   /x/public-api/v1/status        online?, players online/max, version, motd, address
//   /x/public-api/v1/players       the names online right now (if enabled)
//   /x/public-api/v1/leaderboards  which boards exist
//   /x/public-api/v1/leaderboard/:board?limit=10
export default function (ctx) {
  const ok = (req) => {
    const key = ctx.settings.get().apiKey;
    if (!key) return true;
    const given = String(req.headers["x-api-key"] ?? req.query.key ?? "");
    const a = Buffer.from(given), b = Buffer.from(key);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const cors = () => ({ "Access-Control-Allow-Origin": ctx.settings.get().origin || "*", "Access-Control-Allow-Headers": "x-api-key", "Cache-Control": "public, max-age=10" });
  const guard = (fn) => async (req) => {
    if (!ok(req)) return { status: 401, headers: cors(), body: { error: "Missing or wrong API key" } };
    try { return { headers: cors(), body: await fn(req) }; } catch (e) { return { status: 500, headers: cors(), body: { error: "Couldn't read the server" } }; }
  };
  const live = async () => {
    const st = await ctx.mc.live();
    if (!st) return { online: false };
    return st;
  };

  ctx.route("GET", "/v1/status", { public: true }, guard(async () => {
    const st = await live();
    return { online: Boolean(st.online), players: st.online ? { online: st.players?.online ?? 0, max: st.players?.max ?? 0 } : { online: 0, max: 0 }, version: st.online ? st.version ?? null : null, motd: st.online ? st.motd ?? null : null, address: st.address ?? null };
  }));
  ctx.route("GET", "/v1/players", { public: true }, guard(async () => {
    const st = await live();
    const s = ctx.settings.get();
    return { online: st.online ? st.players?.online ?? 0 : 0, players: st.online && s.showNames ? st.players?.names ?? [] : [] };
  }));
  ctx.route("GET", "/v1/leaderboards", { public: true }, guard(async () => ({ boards: Object.entries(BOARDS).map(([id, b]) => ({ id, label: b.label })) })));
  ctx.route("GET", "/v1/leaderboard/:board", { public: true }, guard(async (req) => {
    const server = ctx.mc.servers()[0];
    if (!server) return { rows: [] };
    const st = await live();
    const hide = String(ctx.settings.get().hidden ?? "").split(",").map((x) => x.trim()).filter(Boolean);
    const r = await computeBoard(server.root, st.level ?? "world", req.params.board, { limit: Number(req.query.limit) || 10, exclude: hide });
    if (!r) throw Object.assign(new Error("Unknown board"), { status: 404 });
    return r;
  }));
  ctx.route("OPTIONS", "/v1/status", { public: true }, async () => ({ status: 204, headers: cors(), body: "" }));
}
