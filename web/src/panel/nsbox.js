import { h, api, toast } from "../ui.js";
import { copyText } from "./pages.js";

const copyCell = (text) => h("button", { class: "copycell", title: "Copy", onclick: () => copyText(text) }, h("code", {}, text), h("span", { class: "cp" }, "⧉"));

// Console answers DNS itself. You hand a domain over once; after that new names (play, shop, panel...) just work.
export function nsCard() {
  const box = h("div", { class: "panel" }, h("h2", {}, "Console DNS (nameserver)"), h("p", { class: "muted" }, "Loading…"));
  const out = h("div", { class: "stack wide" });

  async function draw() {
    const s = await api("/ns");
    const zone = h("input", { placeholder: "mc.yourdomain.com  or  yourdomain.com", autocomplete: "off", spellcheck: "false" });
    const save = async (patch) => {
      try {
        const r = await api("/ns", { method: "PUT", body: patch });
        if (r.needsRestart) {
          toast("Console needs one restart to use port 53. Restarting…");
          await api("/restart", { method: "POST", body: {} }).catch(() => {});
          setTimeout(() => location.reload(), 5000);
          return;
        }
        if (r.note) toast(r.note);
        draw();
      } catch (e) { toast(e.message, true); }
    };
    box.replaceChildren(
      h("h2", {}, "Console DNS (nameserver)"),
      h("p", { class: "muted" }, "No Cloudflare or Vercel token. Console answers DNS for your domain itself, so the admin panel, play address and website names are created automatically. The one catch: if this machine is off, those names stop resolving. Prefer that? Use the normal DNS records below instead."),
      h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.enabled, onchange: (e) => save({ enabled: e.target.checked, zones: s.zones.map((z) => z.zone) }) }), "Turn on Console DNS (listens on port 53)"),
      s.problem ? h("div", { class: "error" }, s.problem) : null,
      s.enabled ? h("p", { class: s.listening ? "good" : "muted" }, s.listening ? "Running and answering queries." : "Not running yet.") : null,
      h("h3", {}, "Domains Console answers for"),
      s.zones.length ? null : h("p", { class: "muted small" }, "None yet. Add a whole domain you bought for this (best) or a sub-name like mc.yourdomain.com. A whole domain you already use elsewhere would lose its other records, so use a sub-name for those."),
      ...s.zones.map((z) => h("div", { class: "panel" },
        h("div", { class: "row" }, h("b", {}, z.zone), h("button", { onclick: () => save({ zones: s.zones.map((x) => x.zone).filter((x) => x !== z.zone) }) }, "Remove")),
        h("p", {}, z.title),
        h("ol", {}, ...z.steps.map((t) => h("li", { class: "small" }, t))),
        z.records.length ? h("table", { class: "dns" }, h("thead", {}, h("tr", {}, ...["Type", "Name", "Value"].map((x) => h("th", {}, x)))), h("tbody", {}, ...z.records.map((r) => h("tr", {}, h("td", {}, r.type), h("td", {}, copyCell(r.name)), h("td", {}, copyCell(r.value)))))) : null,
        z.whole ? h("div", { class: "row tight" }, ...z.nsNames.map((n) => copyCell(n)), h("span", { class: "muted small" }, `both point to ${s.ip}`)) : null,
        h("div", { class: "row" }, h("button", { onclick: async () => {
          try {
            const c = await api("/ns/check"); const m = c.zones.find((x) => x.zone === z.zone);
            toast(m.delegated ? "Delegation works. The internet is asking Console." : `Not delegated yet${m.found.length ? ` (it still points at ${m.found.join(", ")})` : ""}. This can take up to a day.`, !m.delegated);
          } catch (e) { toast(e.message, true); }
        } }, "Check it now"))),),
      h("div", { class: "row" }, zone, h("button", { class: "primary", onclick: () => zone.value.trim() && save({ zones: [...s.zones.map((x) => x.zone), zone.value.trim()], enabled: s.enabled }) }, "Add domain")),
      s.hosts.length ? h("p", { class: "muted small" }, `Names Console will answer automatically: ${s.hosts.join(", ")}.`) : null,
      out
    );
  }
  draw().catch((e) => box.replaceChildren(h("div", { class: "error" }, e.message)));
  return box;
}
