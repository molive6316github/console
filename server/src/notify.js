import { getSetting, audit } from "./db.js";

// Discord and Slack style incoming webhooks. We send both `content` (Discord) and `text` (Slack).
export function validWebhook(url) {
  let u;
  try { u = new URL(url); } catch { return "That isn't a valid URL"; }
  if (u.protocol !== "https:") return "The webhook URL must start with https://";
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(h) || h === "[::1]" || h.startsWith("[")) {
    return "The webhook can't point at a private or local address";
  }
  return null;
}

export const maskWebhook = (url) => {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.origin}/…${url.slice(-4)}`;
  } catch {
    return "set";
  }
};

export function createNotifier({ db, fetchImpl = fetch }) {
  async function send(text) {
    const url = getSetting(db, "alert_webhook");
    if (!url) return { sent: false, reason: "no webhook set" };
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, text }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error",
      });
      if (!res.ok) throw new Error(`webhook answered HTTP ${res.status}`);
      return { sent: true };
    } catch (e) {
      audit(db, { username: "system", action: "alert", ok: false, detail: e.message });
      return { sent: false, reason: e.message };
    }
  }
  return { send };
}
