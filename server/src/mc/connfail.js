import { listServers } from "../db.js";
import { mcRoot } from "./index.js";
import { getDriver } from "../drivers/index.js";

// Log lines that mean "a player tried to join and the SERVER broke", as opposed to a ban, a whitelist, or a normal quit.
export const CLUES = [
  { kind: "error", re: /^(?:\[[^\]]*\]\s*(?:\[[^\]]*\])?:?\s*)?(\w{1,16}) lost connection: Internal Exception/i, hint: "The server hit an internal error while this player was joining." },
  { kind: "error", re: /Could not pass event Player(?:Login|Join|PreLogin)Event to (\S+)/i, hint: "A plugin crashed while handling a player joining.", plugin: true },
  { kind: "error", re: /Failed to handle packet.*?(?:\bfor\b|\bfrom\b)\s+(\w{1,16})/i, hint: "The server couldn't process a packet from a joining player." },
  { kind: "auth", re: /Failed to verify username[!:]?\s*(\w{1,16})?/i, hint: "Mojang's login servers didn't answer, or online-mode is wrong for this setup." },
  { kind: "error", re: /Exception (?:in|while) (?:handling )?(?:login|joining|PlayerJoin)/i, hint: "An exception happened during login." },
];

export function scan(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const l = line.trim();
    if (!l) continue;
    for (const c of CLUES) {
      const m = c.re.exec(l);
      if (m) { out.push({ kind: c.kind, line: l.slice(0, 300), player: c.plugin ? null : (m[1] ?? null), plugin: c.plugin ? m[1] : null, hint: c.hint }); break; }
    }
  }
  return out;
}

// Watches each server's recent output and keeps a short list of join failures for the panel to show.
export function createConnWatcher({ db, now = () => Date.now(), tail = async (server) => getDriver(server.type).logs?.(server.target, 200, { id: server.id }) }) {
  const seen = new Map(); // server id -> Set of lines already handled
  const alerts = [];
  let seq = 0;

  async function tick() {
    for (const server of listServers(db)) {
      if (!mcRoot(server)) continue;
      let text = "";
      try { text = (await tail(server)) ?? ""; } catch { continue; }
      const first = !seen.has(server.id);
      const known = seen.get(server.id) ?? new Set();
      const hits = scan(text);
      for (const h of hits) {
        if (known.has(h.line)) continue;
        known.add(h.line);
        if (!first) alerts.unshift({ id: ++seq, at: now(), serverId: server.id, serverName: server.name, ...h });
      }
      seen.set(server.id, new Set([...known].slice(-300))); // the first look only learns what's already there, so old errors don't pop up on boot
    }
    alerts.length = Math.min(alerts.length, 20);
  }

  return { tick, list: (since = 0) => alerts.filter((a) => a.id > since), dismiss: (id) => { const i = alerts.findIndex((a) => a.id === id); if (i >= 0) alerts.splice(i, 1); }, clear: () => (alerts.length = 0) };
}
