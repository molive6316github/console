#!/usr/bin/env node
// The assistant's only tool. It calls Console's own API as the person who asked, so it can do exactly what they can and no more.
//   console-ctl routes [text]                 list the API routes (optionally filtered)
//   console-ctl api METHOD /api/path [json]   call one
// Risky calls (stop/restart, delete, restore…) pause until the person approves them in the chat.
const [, , cmd, ...rest] = process.argv;
const base = process.env.CONSOLE_URL;
const token = process.env.CONSOLE_AGENT_TOKEN;
if (!base || !token) { console.error("console-ctl only works when Console starts the assistant."); process.exit(2); }

const call = async (method, path, body, extra = {}) => {
  const res = await fetch(base + path, { method, headers: { "x-console-agent": token, ...(body !== undefined ? { "content-type": "application/json" } : {}), ...extra }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* plain text */ }
  return { status: res.status, text, json };
};
const show = (r) => { console.log(`HTTP ${r.status}`); console.log(r.text.length > 6000 ? r.text.slice(0, 6000) + "\n…(cut: ask for less, e.g. a smaller range)" : r.text); process.exit(r.status < 400 ? 0 : 1); };

if (cmd === "routes") {
  const r = await call("GET", "/api/assistant/routes");
  const filter = (rest[0] ?? "").toLowerCase();
  const rows = (r.json?.routes ?? []).filter((x) => !filter || `${x.method} ${x.url}`.toLowerCase().includes(filter));
  console.log(rows.map((x) => `${x.method} ${x.url}`).join("\n") || "(none)");
} else if (cmd === "api") {
  const [method, path, raw] = rest;
  if (!method || !path?.startsWith("/api/")) { console.error('usage: console-ctl api METHOD /api/path [\'{"json":"body"}\']'); process.exit(2); }
  let body;
  if (raw !== undefined) { try { body = JSON.parse(raw); } catch { console.error("The body must be valid JSON."); process.exit(2); } }
  else if (!["GET", "DELETE", "HEAD"].includes(method.toUpperCase())) body = {};
  let r = await call(method.toUpperCase(), path, body);
  if (r.status === 409 && r.json?.needsApproval) {
    console.error(`Waiting for the person to approve: ${r.json.summary}`);
    const end = Date.now() + 5 * 60_000;
    for (;;) {
      await new Promise((ok) => setTimeout(ok, 2000));
      const a = await call("GET", `/api/assistant/approvals/${r.json.approvalId}`);
      if (a.json?.state === "denied") { console.log("The person said no. Do not retry; tell them you stopped."); process.exit(3); }
      if (a.json?.state === "approved") { r = await call(method.toUpperCase(), path, body, { "x-approval": r.json.approvalId }); break; }
      if (Date.now() > end) { console.log("No answer in 5 minutes, so nothing was done."); process.exit(4); }
    }
  }
  show(r);
} else {
  console.error("console-ctl routes [text] | console-ctl api METHOD /api/path [json]");
  process.exit(2);
}
