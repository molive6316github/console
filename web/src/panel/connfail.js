import { h, api, toast } from "../ui.js";
import { followJob } from "../views/create.js";

// A big popup when the server itself breaks while someone is joining. Polls quietly; shows one alert at a time.
export function watchJoinFailures() {
  let since = 0;
  let open = false;
  let stop = false;

  async function poll() {
    if (stop) return;
    if (!open) {
      try {
        const r = await api(`/connfail?since=${since}`);
        if (r.alerts.length) {
          const a = r.alerts[r.alerts.length - 1];
          since = Math.max(...r.alerts.map((x) => x.id));
          show(a, r.autofix);
        }
      } catch { /* not an admin, or offline: stay quiet */ }
    }
    setTimeout(poll, 8000);
  }

  function show(a, autofixOn) {
    open = true;
    const out = h("div", { class: "stack wide" });
    const close = () => { open = false; overlay.remove(); api("/connfail/dismiss", { method: "POST", body: { id: a.id } }).catch(() => {}); };
    const fix = h("button", { class: "primary", onclick: async () => {
      fix.disabled = true;
      try {
        const r = await api("/autofix/run", { method: "POST", body: { scope: "minecraft", target: a.serverId, note: `A player could not join. Log line: ${a.line}` } });
        followJob(out, r.jobId, { onDone: () => (fix.disabled = false) });
      } catch (e) { fix.disabled = false; toast(e.message, true); }
    } }, "Fix with AI");
    const overlay = h("div", { class: "connfail", role: "alertdialog", "aria-label": "A player couldn't connect" },
      h("div", { class: "connfail-box" },
        h("h2", {}, a.player ? `${a.player} couldn't join` : "A player couldn't join"),
        h("p", {}, a.hint),
        a.plugin ? h("p", { class: "muted" }, `The plugin involved looks like: ${a.plugin}`) : null,
        h("pre", { class: "snippet" }, a.line),
        h("p", { class: "muted small" }, `${a.serverName} · ${new Date(a.at).toLocaleTimeString()}`),
        out,
        h("div", { class: "row" },
          autofixOn ? fix : h("span", { class: "muted small" }, "Turn on Auto-fix (sidebar) to get a Fix with AI button here."),
          h("button", { onclick: () => { close(); location.hash = "#/golive"; } }, "Open Diagnose"),
          h("button", { onclick: close }, "Dismiss"))));
    document.body.append(overlay);
  }

  poll();
  return () => { stop = true; };
}
