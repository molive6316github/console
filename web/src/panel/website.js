import { h, api, toast, field } from "../ui.js";
import { copyText } from "./pages.js";

const STATE = { ok: ["✓ DNS correct", "good"], wrong: ["✗ DNS points elsewhere", "bad"], missing: ["… DNS not added yet", "wait"], error: ["? couldn't check DNS", "wait"] };

export async function websitePage(box, { server, life }) {
  const root = h("div", { class: "stack wide" });
  box.append(root);
  void life;

  async function load() {
    const [data, join] = await Promise.all([api("/sites"), api(`/servers/${encodeURIComponent(server.id)}/mc/join`).catch(() => null)]);
    const host = h("input", { placeholder: "shop.yourdomain.com", autocomplete: "off", spellcheck: "false" });
    const tpl = h("select", {}, ...data.templates.map((t) => h("option", { value: t.id }, `${t.label}: ${t.blurb}`)));
    tpl.value = "store";
    root.replaceChildren(
      h("div", { class: "panel" },
        h("h2", {}, "Websites"),
        h("p", { class: "muted" }, "A page for your server on its own address, like shop.donutsmp.net. Pick a template, fill in the form, done. It's served by Console itself, so there's nothing else to install."),
        data.sites.length ? null : h("p", { class: "muted" }, "No websites yet."),
        h("div", { class: "stack wide" },
          field("Address", host, "Use a name you own. A subdomain like shop.yourdomain.com works great."),
          field("Template", tpl),
          h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
            try {
              const r = await api("/sites", { method: "POST", body: { host: host.value.trim(), template: tpl.value, ip: join?.address ?? "" } });
              toast(r.routed ? "Website created" : "Website created. One more step below.");
              load();
            } catch (e) { toast(e.message, true); }
          } }, "Create website")))),
      ...data.sites.map((s) => siteCard(s, load))
    );
  }

  load().catch((e) => root.replaceChildren(h("div", { class: "error" }, e.message)));
}

function siteCard(s, reload) {
  const url = `https://${s.host}/`;
  const body = h("div", { class: "stack wide" });
  const dns = h("div", { class: "muted small" }, "Checking DNS…");
  const routeNote = h("div");

  api("/dns/check").then((r) => {
    const mine = r.hosts.find((x) => x.host === s.host);
    const st = mine?.records[0]?.check?.state ?? "error";
    const [label, cls] = STATE[st] ?? STATE.error;
    dns.replaceChildren(h("span", { class: cls }, label), st === "ok" ? null : h("span", {}, "  Open \"Join address & status page\" to copy or auto-add the record."));
  }).catch(() => (dns.textContent = ""));

  const card = h("div", { class: "panel" },
    h("div", { class: "row" }, h("h2", {}, s.host), h("a", { href: url, target: "_blank", rel: "noopener" }, "Open ↗")),
    dns,
    routeNote,
    body,
    h("div", { class: "row" }, h("button", { class: "danger", onclick: async () => {
      if (!confirm(`Delete the website ${s.host}? Its files are removed.`)) return;
      try { await api(`/sites/${encodeURIComponent(s.host)}`, { method: "DELETE" }); toast("Deleted"); reload(); } catch (e) { toast(e.message, true); }
    } }, "Delete website")));

  const showRouting = (r) => {
    if (r.routed) { routeNote.replaceChildren(h("p", { class: "muted small" }, "HTTPS is set up. The certificate is issued the first time someone visits.")); return; }
    routeNote.replaceChildren(h("div", { class: "panel good" },
      h("p", {}, r.error ?? "Console couldn't set up HTTPS for this address automatically (it needs Caddy and passwordless sudo, so Docker installs can't)."),
      h("p", { class: "muted small" }, "Add this to your Caddyfile, then reload Caddy:"),
      h("pre", { class: "snippet" }, r.snippet),
      h("div", { class: "row" },
        h("button", { onclick: () => copyText(r.snippet) }, "Copy"),
        h("button", { onclick: async () => { try { showRouting(await api(`/sites/${encodeURIComponent(s.host)}/route`, { method: "POST", body: {} })); } catch (e) { toast(e.message, true); } } }, "Try again"))));
  };
  api(`/sites/${encodeURIComponent(s.host)}/route`, { method: "POST", body: {} }).then(showRouting).catch(() => {});

  if (s.files.includes("site.json")) formEditor(body, s);
  fileEditor(body, s);
  return card;
}

function formEditor(body, s) {
  const e = encodeURIComponent(s.host);
  const f = { title: h("input"), tagline: h("input"), ip: h("input", { placeholder: "play.yourdomain.com" }), accent: h("input", { type: "color" }), discord: h("input", { placeholder: "https://discord.gg/…" }), storeUrl: h("input", { placeholder: "https://yourserver.tebex.io" }) };
  const prods = h("div", { class: "stack wide" });
  const addProd = (p = {}) => {
    const row = { name: h("input", { value: p.name ?? "", placeholder: "VIP Rank" }), price: h("input", { value: p.price ?? "", placeholder: "$9.99" }), desc: h("input", { value: p.desc ?? "", placeholder: "What they get" }), url: h("input", { value: p.url ?? "", placeholder: "https://checkout link" }) };
    const el = h("div", { class: "prod" }, row.name, row.price, row.desc, row.url, h("button", { onclick: () => el.remove() }, "Remove"));
    el.read = () => ({ name: row.name.value, price: row.price.value, desc: row.desc.value, url: row.url.value });
    prods.append(el);
  };
  const save = async () => {
    try {
      await api(`/sites/${e}/config`, { method: "PUT", body: { title: f.title.value, tagline: f.tagline.value, ip: f.ip.value, accent: f.accent.value, discord: f.discord.value, storeUrl: f.storeUrl.value, products: [...prods.children].map((c) => c.read()) } });
      toast("Saved. Refresh the site to see it.");
    } catch (err) { toast(err.message, true); }
  };
  const wrap = h("div", { class: "stack wide" }, h("h3", {}, "Page content"), h("p", { class: "muted small" }, "Loading…"));
  api(`/sites/${e}/config`).then(({ config: c }) => {
    f.title.value = c.title; f.tagline.value = c.tagline; f.ip.value = c.ip; f.accent.value = c.accent; f.discord.value = c.discord; f.storeUrl.value = c.storeUrl;
    c.products.forEach(addProd);
    wrap.replaceChildren(
      h("h3", {}, "Page content"),
      field("Server name", f.title), field("Tagline", f.tagline), field("Join address shown on the page", f.ip),
      field("Accent colour", f.accent), field("Discord link", f.discord), field("Store link (big button)", f.storeUrl),
      h("h3", {}, "Store products"),
      h("p", { class: "muted small" }, "Cards link to your checkout (Tebex, Stripe, a payment link…). Console doesn't take payments itself."),
      prods,
      h("div", { class: "row" }, h("button", { onclick: () => addProd() }, "+ Add product"), h("button", { class: "primary", onclick: save }, "Save page"))
    );
  }).catch((err) => wrap.replaceChildren(h("div", { class: "error" }, err.message)));
  body.append(wrap);
}

function fileEditor(body, s) {
  const e = encodeURIComponent(s.host);
  const sel = h("select", {}, ...s.files.filter((n) => /\.(html|css|js|json|txt|md|svg)$/.test(n)).map((n) => h("option", { value: n }, n)));
  const area = h("textarea", { class: "code", rows: "14", spellcheck: "false" });
  const load = () => api(`/sites/${e}/files/${encodeURIComponent(sel.value)}`).then((r) => (area.value = r.text)).catch((err) => toast(err.message, true));
  sel.addEventListener("change", load);
  const det = h("details", {}, h("summary", {}, "Advanced: edit the page files directly"),
    h("div", { class: "stack wide" }, sel, area,
      h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { try { await api(`/sites/${e}/files/${encodeURIComponent(sel.value)}`, { method: "PUT", body: { text: area.value } }); toast("Saved"); } catch (err) { toast(err.message, true); } } }, "Save file"))));
  det.addEventListener("toggle", () => det.open && sel.value && load(), { once: true });
  body.append(det);
}
