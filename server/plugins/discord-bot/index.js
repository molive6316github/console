import { createPublicKey, verify } from "node:crypto";
import { computeBoard, BOARDS } from "../../src/leaderboards.js";

const SPKI = Buffer.from("302a300506032b6570032100", "hex");
const HOOK = /^https:\/\/(discord|discordapp)\.com\/api\/(v\d+\/)?webhooks\/\d+\/[\w-]+$/;

export function verifySignature(publicKeyHex, signatureHex, timestamp, raw) {
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI, Buffer.from(publicKeyHex, "hex")]), format: "der", type: "spki" });
    return verify(null, Buffer.from(String(timestamp) + String(raw)), key, Buffer.from(signatureHex, "hex"));
  } catch { return false; }
}

export default function (ctx) {
  const post = async (text) => {
    const url = ctx.settings.get().webhookUrl;
    if (!url || !HOOK.test(url)) return false;
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: String(text).slice(0, 1900), allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(10_000) });
    return r.ok;
  };
  const s = () => ctx.settings.get();
  ctx.on("player:join", (e) => s().joins && post(`🟢 **${e.name}** joined (${e.online ?? "?"} online)`));
  ctx.on("player:leave", (e) => s().leaves && post(`⚪ **${e.name}** left (${e.online ?? 0} online)`));
  ctx.on("server:up", (e) => s().updown && post(`✅ **${e.server}** is online`));
  ctx.on("server:down", (e) => s().updown && post(`🔴 **${e.server}** went offline`));

  ctx.route("POST", "/test", async () => ({ body: { sent: await post("👋 Console can reach this channel.") } }));

  // Discord calls this for every slash command; the signature proves it's really Discord.
  ctx.route("POST", "/interactions", { public: true }, async (req) => {
    const { publicKey } = s();
    if (!publicKey || !verifySignature(publicKey, String(req.headers["x-signature-ed25519"] ?? ""), req.headers["x-signature-timestamp"], req.raw ?? "")) return { status: 401, body: "invalid request signature" };
    const i = req.body ?? {};
    if (i.type === 1) return { body: { type: 1 } };
    if (i.type !== 2) return { body: { type: 4, data: { content: "I don't know that one." } } };
    const reply = (content) => ({ body: { type: 4, data: { content: String(content).slice(0, 1900), allowed_mentions: { parse: [] } } } });
    const name = i.data?.name;
    const st = await ctx.mc.live().catch(() => null);
    if (name === "status") return reply(st?.online ? `🟢 **Online**: ${st.players?.online ?? 0}/${st.players?.max ?? 0} players${st.version ? ` on ${st.version}` : ""}${st.address ? `\nJoin: \`${st.address}\`` : ""}` : "🔴 The server is offline right now.");
    if (name === "players") { const n = st?.online ? st.players?.names ?? [] : []; return reply(st?.online ? (n.length ? `**${st.players.online} online:** ${n.join(", ")}` : `${st.players?.online ?? 0} online`) : "The server is offline."); }
    if (name === "leaderboard") {
      const board = i.data?.options?.find((o) => o.name === "board")?.value ?? "playtime";
      const server = ctx.mc.servers()[0];
      const r = server && (await computeBoard(server.root, st?.level ?? "world", board, { limit: 10 }));
      if (!r) return reply("No such leaderboard.");
      return reply(r.rows.length ? `**${r.label}**\n${r.rows.map((x) => `${x.rank}. ${x.name}: ${x.display}`).join("\n")}` : `Nothing on the ${r.label} board yet.`);
    }
    return reply("I don't know that command.");
  });

  // One click from the panel registers the slash commands with Discord.
  ctx.route("POST", "/register", async () => {
    const { appId, botToken } = s();
    if (!/^\d{5,25}$/.test(appId ?? "") || !botToken) return { status: 400, body: { error: "Fill in the Application ID and Bot token first" } };
    const cmds = [
      { name: "status", description: "Is the server online, and how many are playing?" },
      { name: "players", description: "Who is online right now" },
      { name: "leaderboard", description: "Top players", options: [{ type: 3, name: "board", description: "Which board", required: false, choices: Object.entries(BOARDS).map(([value, b]) => ({ name: b.label, value })) }] },
    ];
    const r = await fetch(`https://discord.com/api/v10/applications/${appId}/commands`, { method: "PUT", headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" }, body: JSON.stringify(cmds), signal: AbortSignal.timeout(15_000) });
    return r.ok ? { body: { registered: cmds.map((c) => c.name) } } : { status: 502, body: { error: `Discord said ${r.status}. Check the Application ID and token.` } };
  });
}
