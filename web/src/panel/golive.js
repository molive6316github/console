import { h, api, toast, field } from "../ui.js";

const base = (s) => `/servers/${encodeURIComponent(s.id)}/mc`;
const ICON = { ok: ["✓", "good"], warn: ["!", "wait"], bad: ["✗", "bad"], info: ["i", "wait"] };

export async function goLivePage(box, { server, life }) {
  void life;
  const list = h("div", { class: "stack wide" }, h("p", { class: "muted" }, "Checking…"));
  const sum = h("div", { class: "panel" });
  const offBox = h("div", { class: "panel" });
  box.append(sum, list, offBox);

  async function draw() {
    const g = await api(`${base(server)}/golive`);
    const groups = [...new Set(g.checks.map((c) => c.group))];
    sum.replaceChildren(
      h("h2", {}, g.summary.ready ? "Ready for real players" : `${g.summary.bad} must-fix, ${g.summary.warn} worth doing`),
      h("p", { class: "muted" }, g.summary.ready ? "Everything Console can check looks good. Open the doors." : "Fix the red ones before you tell anyone the address. Yellow ones are strongly recommended."),
      h("div", { class: "row" }, h("button", { onclick: () => draw().catch(() => {}) }, "Check again"))
    );
    list.replaceChildren(...groups.map((grp) => h("div", { class: "panel" }, h("h3", {}, grp),
      ...g.checks.filter((c) => c.group === grp).map((c) => {
        const [sym, cls] = ICON[c.state] ?? ICON.info;
        return h("div", { class: "row tight golive-row" },
          h("span", { class: `gl-ico ${cls}` }, sym),
          h("div", { class: "grow" }, h("b", {}, c.label), h("div", { class: "muted small" }, c.detail)),
          c.fix ? h("button", { class: "primary", onclick: async () => {
            try { const r = await api(`${base(server)}/golive/fix`, { method: "POST", body: { id: c.fix.id } }); toast(r.message); await draw(); } catch (e) { toast(e.message, true); }
          } }, c.fix.label) : null);
      }))));
  }
  draw().catch((e) => list.replaceChildren(h("div", { class: "error" }, e.message)));
  drawOffsite(offBox, draw);
}

async function drawOffsite(box, redraw) {
  const o = await api("/offsite");
  const f = { endpoint: h("input", { placeholder: "https://objectstorage.us-ashburn-1.oraclecloud.com", value: o.endpoint ?? "" }), region: h("input", { placeholder: "us-ashburn-1", value: o.region ?? "" }), bucket: h("input", { placeholder: "minecraft-backups", value: o.bucket ?? "" }), accessKey: h("input", { placeholder: o.configured ? `ending ${o.accessKeyTail}` : "Access key", autocomplete: "off" }), secretKey: h("input", { type: "password", placeholder: o.configured ? "(saved, leave blank to keep)" : "Secret key", autocomplete: "off" }), prefix: h("input", { value: o.prefix ?? "console-backups" }), keep: h("input", { type: "number", min: "1", max: "365", value: o.keep ?? 14 }) };
  const save = async () => {
    try {
      await api("/offsite", { method: "PUT", body: { endpoint: f.endpoint.value, region: f.region.value, bucket: f.bucket.value, accessKey: f.accessKey.value || undefined, secretKey: f.secretKey.value, prefix: f.prefix.value, keep: f.keep.value } });
      toast("Connected. Every backup is now copied there too.");
      drawOffsite(box, redraw); redraw();
    } catch (e) { toast(e.message, true); }
  };
  box.replaceChildren(
    h("h2", {}, "Copy backups off this machine"),
    h("p", { class: "muted" }, "Any S3-compatible storage works: Oracle Object Storage (free tier has 20 GB), Backblaze B2, Cloudflare R2, AWS. After each world backup, Console uploads it and keeps the newest copies."),
    o.configured ? h("p", {}, `Connected to bucket ${o.bucket} (keeping ${o.keep}).`) : null,
    h("details", { open: !o.configured },
      h("summary", {}, o.configured ? "Change settings" : "Set it up"),
      h("div", { class: "stack wide" },
        field("Endpoint", f.endpoint, "Oracle: https://<namespace>.compat.objectstorage.<region>.oraclecloud.com . Backblaze: https://s3.<region>.backblazeb2.com"),
        field("Region", f.region), field("Bucket", f.bucket), field("Access key", f.accessKey), field("Secret key", f.secretKey),
        field("Folder in the bucket", f.prefix), field("Copies to keep", f.keep),
        h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Test and save"),
          o.configured ? h("button", { onclick: async () => { try { await api("/offsite/test", { method: "POST", body: {} }); toast("Works"); } catch (e) { toast(e.message, true); } } }, "Test again") : null,
          o.configured ? h("button", { class: "danger", onclick: async () => { await api("/offsite", { method: "DELETE" }); drawOffsite(box, redraw); redraw(); } }, "Stop copying") : null),
        h("small", { class: "muted" }, "Keys are stored on this server only and never shown again. Use keys that can only touch this one bucket."))));
}
