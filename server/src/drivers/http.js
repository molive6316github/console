// Read-only: "is this site alive?"
// target: { url: "https://...", expectStatus?: 200, timeoutMs?: 4000 }
import { clean, pickString, pickInt, TargetError } from "./exec.js";

export default {
  type: "http",
  readOnly: true,
  supports: { logs: false },
  validate(t) {
    const url = pickString(t, "url", { max: 2000, required: true });
    let u;
    try { u = new URL(url); } catch { throw new TargetError("url is not valid"); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new TargetError("url must start with http:// or https://");
    return clean({ url, expectStatus: pickInt(t, "expectStatus", 100, 599), timeoutMs: pickInt(t, "timeoutMs", 500, 30000) });
  },
  async status(target) {
    let url;
    try {
      url = new URL(target.url);
    } catch {
      return "unknown";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown";
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(target.timeoutMs ?? 4000),
      });
      const ok = target.expectStatus ? res.status === target.expectStatus : res.ok;
      return ok ? "up" : "down";
    } catch {
      return "down";
    }
  },
  async start() {
    throw new Error("http servers are read-only");
  },
  async stop() {
    throw new Error("http servers are read-only");
  },
  async restart() {
    throw new Error("http servers are read-only");
  },
  async logs() {
    return "http driver: no logs";
  },
};
