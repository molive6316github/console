import { h, api, toast, field } from "../ui.js";
import { atLeast } from "../level.js";

const base = (s) => `/servers/${encodeURIComponent(s.id)}/mc`;

// ---- Players + quick actions ----------------------------------------------------------
export function playersTab(box, { server, life }) {
  const statusBox = h("div", {});
  const quick = h("div", {});
  const lists = h("div", {});
  box.append(h("div", { class: "panel" }, h("h2", {}, "Online now"), statusBox), quick, lists);

  async function act(action, extra = {}, { confirmText } = {}) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await api(`${base(server)}/action`, { method: "POST", body: { action, ...extra } });
      toast("Sent");
      setTimeout(refresh, 1200);
    } catch (e) {
      toast(e.message, true);
    }
  }

  const nameInput = h("input", { placeholder: "Player name", autocomplete: "off", spellcheck: "false" });
  const msgInput = h("input", { placeholder: "Say something to everyone…", autocomplete: "off" });

  quick.append(
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Quick actions"),
      h("div", { class: "row" }, h("button", { class: "primary", onclick: () => act("save-all") }, "Save world now"), h("button", { onclick: () => act("time", { value: "day" }) }, "Make it day"), h("button", { onclick: () => act("time", { value: "night" }) }, "Make it night"), h("button", { onclick: () => act("weather", { value: "clear" }) }, "Clear weather"), h("button", { onclick: () => act("weather", { value: "rain" }) }, "Rain")),
      h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), msgInput.value.trim() && (act("say", { message: msgInput.value }), (msgInput.value = ""))) }, msgInput, h("button", { type: "submit" }, "Announce")),
      h(
        "div",
        { class: "row" },
        nameInput,
        h("button", { onclick: () => nameInput.value && act("whitelist-add", { player: nameInput.value.trim() }) }, "Whitelist"),
        h("button", { onclick: () => nameInput.value && act("op", { player: nameInput.value.trim() }, { confirmText: `Make ${nameInput.value} an operator? They get full control in-game.` }) }, "Make op"),
        h("button", { class: "danger", onclick: () => nameInput.value && act("ban", { player: nameInput.value.trim() }, { confirmText: `Ban ${nameInput.value}?` }) }, "Ban")
      ),
      atLeast("standard") &&
        h(
          "div",
          { class: "row" },
          h("button", { onclick: () => act("whitelist-on") }, "Whitelist on"),
          h("button", { onclick: () => act("whitelist-off") }, "Whitelist off"),
          h("select", { onchange: (e) => e.target.value && act("difficulty", { value: e.target.value }) }, h("option", { value: "" }, "Difficulty…"), ...["peaceful", "easy", "normal", "hard"].map((d) => h("option", { value: d }, d)))
        )
    )
  );

  async function refresh() {
    let p;
    try {
      p = await api(`${base(server)}/players`);
    } catch (e) {
      return void statusBox.replaceChildren(h("div", { class: "error" }, e.message));
    }
    if (life.dead) return;
    statusBox.replaceChildren(
      !p.up
        ? h("p", { class: "muted" }, "The server is off. Start it to see who's online.")
        : p.count === null
          ? h("p", { class: "muted" }, "Asked the server who's online but it hasn't answered yet.")
          : h(
              "div",
              {},
              h("p", {}, `${p.count} of ${p.max} online`),
              p.players.length === 0
                ? h("p", { class: "muted" }, "Nobody right now.")
                : h("table", {}, h("tbody", {}, ...p.players.map((n) => h("tr", {}, h("td", {}, n, p.ops.includes(n) && h("span", { class: "tag" }, "op")), h("td", { class: "right nowrap" }, h("button", { onclick: () => act("kick", { player: n }) }, "Kick"), " ", h("button", { onclick: () => act("op", { player: n }, { confirmText: `Make ${n} an operator?` }) }, "Op"), " ", h("button", { class: "danger", onclick: () => act("ban", { player: n }, { confirmText: `Ban ${n}?` }) }, "Ban"))))))
            )
    );
    const chip = (n, onRemove, label) => h("span", { class: "tag" }, n, " ", h("a", { href: "#", title: label, onclick: (e) => (e.preventDefault(), onRemove()) }, "×"));
    lists.replaceChildren(...[
      h("div", { class: "panel" }, h("h2", {}, `Whitelist (${p.whitelist.length})`), p.whitelist.length ? h("div", {}, ...p.whitelist.map((n) => chip(n, () => act("whitelist-remove", { player: n }), "Remove from whitelist"))) : h("p", { class: "muted" }, "Empty.")),
      p.ops.length > 0 && h("div", { class: "panel" }, h("h2", {}, "Operators"), h("div", {}, ...p.ops.map((n) => chip(n, () => act("deop", { player: n }, { confirmText: `Remove operator from ${n}?` }), "Remove op")))),
      p.banned.length > 0 && h("div", { class: "panel" }, h("h2", {}, "Banned"), h("div", {}, ...p.banned.map((b) => chip(b.name, () => act("pardon", { player: b.name }), "Unban"))))
    ].filter(Boolean));
  }
  refresh();
  life.every(refresh, 10_000);
}

// ---- Game settings (server.properties) --------------------------------------------------
export async function gameTab(box, { server, reload }) {
  let data;
  try {
    data = await api(`${base(server)}/properties`);
  } catch (e) {
    return void box.append(h("div", { class: "error" }, e.message));
  }
  const inputs = new Map();
  const groups = new Map();
  for (const f of data.known) {
    if (f.value === null) continue; // not in this server's file yet: Minecraft will add it on first run
    let ctl;
    if (f.type === "bool") ctl = h("input", { type: "checkbox", checked: f.value === "true" });
    else if (f.type === "select") (ctl = h("select", {}, ...f.options.map((o) => h("option", { value: o }, o))), (ctl.value = f.value));
    else ctl = h("input", { type: f.type === "int" ? "number" : "text", value: f.value, min: f.min, max: f.max, autocomplete: "off", spellcheck: "false" });
    inputs.set(f.key, { ctl, f, orig: f.value });
    const row = f.type === "bool" ? h("label", { class: "check" }, ctl, f.label) : field(f.label, ctl, f.danger ? "⚠ Changing this has big effects." : undefined);
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(row);
  }
  const otherInputs = new Map();
  const otherPanel = atLeast("advanced") && data.other.length
    ? h("div", { class: "panel" }, h("h2", {}, "Other properties"), h("p", { class: "muted" }, "Anything else in server.properties. Leave secret fields blank to keep them."), h("div", { class: "stack wide" }, ...data.other.map((o) => {
        const ctl = h("input", { value: o.value, type: o.secret ? "password" : "text", placeholder: o.secret ? "(hidden)" : "", autocomplete: "off" });
        otherInputs.set(o.key, { ctl, orig: o.value });
        return field(o.key, ctl);
      })))
    : null;
  const msg = h("div", { class: "error" });
  const restart = h("div", { hidden: true, class: "notice" }, "Saved. Changes take effect after a restart. ", h("button", { onclick: async () => { try { await api(`/servers/${encodeURIComponent(server.id)}/restart`, { method: "POST", body: {} }); toast("Restarting"); reload(); } catch (e) { toast(e.message, true); } } }, "Restart now"));
  const save = async () => {
    msg.textContent = "";
    const changes = {};
    for (const [k, { ctl, f, orig }] of inputs) {
      const v = f.type === "bool" ? String(ctl.checked) : String(ctl.value);
      if (v !== orig) changes[k] = v;
    }
    for (const [k, { ctl, orig }] of otherInputs) if (ctl.value !== orig) changes[k] = ctl.value;
    if (!Object.keys(changes).length) return void toast("Nothing changed");
    const risky = Object.keys(changes).filter((k) => inputs.get(k)?.f.danger);
    if (risky.length && !confirm(`You changed ${risky.join(", ")}. Changing the world name starts a brand-new world, and changing the port breaks the address players use. Save anyway?`)) return;
    try {
      const r = await api(`${base(server)}/properties`, { method: "PUT", body: { changes } });
      toast(`Saved ${r.changed} change${r.changed === 1 ? "" : "s"}`);
      for (const [k, v] of inputs) v.orig = k in changes ? changes[k] : v.orig;
      restart.hidden = false;
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  box.append(
    ...[...groups].map(([name, rows]) => h("div", { class: "panel" }, h("h2", {}, name), h("div", { class: "stack wide" }, ...rows))),
    ...[otherPanel, msg, h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Save changes")), restart].filter(Boolean)
  );
}

// ---- Plugins / mods ---------------------------------------------------------------------
export async function pluginsTab(box, { server, me }) {
  const kindWord = server.mc.kind === "mods" ? "mod" : "plugin";
  const installed = h("div", {});
  const modrinth = h("div", {});
  const github = h("div", {});
  box.append(
    h("p", { class: "notice" }, `Installing a ${kindWord} runs someone else's code on your server. Only add ones you trust. Changes apply after a restart.`),
    h("div", { class: "panel" }, h("h2", {}, `Installed ${kindWord}s`), installed),
    h("div", { class: "panel" }, h("h2", {}, "Find on Modrinth"), modrinth),
    h("div", { class: "panel" }, h("h2", {}, "From GitHub"), github)
  );
  const base = `/servers/${encodeURIComponent(server.id)}/mc`;

  async function drawInstalled() {
    try {
      const { files } = await api(`${base}/plugins`);
      installed.replaceChildren(
        files.length === 0
          ? h("p", { class: "muted" }, `No ${kindWord}s yet.`)
          : h("table", {}, h("tbody", {}, ...files.map((f) => h("tr", { class: f.enabled ? "" : "off" }, h("td", {}, f.file.replace(/\.disabled$/, ""), !f.enabled && h("span", { class: "tag" }, "off")), h("td", { class: "muted" }, `${Math.max(1, Math.round(f.size / 1024))} KB`), h("td", { class: "right nowrap" },
              h("button", { onclick: async () => { try { await api(`${base}/plugins/toggle`, { method: "POST", body: { file: f.file, enabled: !f.enabled } }); drawInstalled(); } catch (e) { toast(e.message, true); } } }, f.enabled ? "Turn off" : "Turn on"), " ",
              h("button", { class: "danger", onclick: async () => { if (!confirm(`Delete ${f.file.replace(/\.disabled$/, "")}? This can't be undone.`)) return; try { await api(`${base}/plugins/delete`, { method: "POST", body: { file: f.file } }); drawInstalled(); } catch (e) { toast(e.message, true); } } }, "Delete"))))))
      );
    } catch (e) {
      installed.replaceChildren(h("div", { class: "error" }, e.message));
    }
  }

  // Modrinth
  const q = h("input", { placeholder: `Search ${kindWord}s (leave blank for the most popular)`, autocomplete: "off" });
  const results = h("div", {});
  const search = async () => {
    results.replaceChildren(h("p", { class: "muted" }, "Searching…"));
    try {
      const r = await api(`${base}/modrinth/search?q=${encodeURIComponent(q.value)}`);
      results.replaceChildren(
        h("p", { class: "muted" }, r.gameVersion ? `Showing ${kindWord}s that work with Minecraft ${r.gameVersion}.` : "Console doesn't know this server's Minecraft version, so results aren't filtered by version."),
        ...r.hits.map((x) => h("div", { class: "row spread" }, h("div", { class: "grow" }, h("b", {}, x.title), h("div", { class: "muted" }, x.description)), h("button", { class: "primary", onclick: async (e) => {
          e.target.disabled = true;
          try { const i = await api(`${base}/modrinth/install`, { method: "POST", body: { slug: x.slug } }); toast(`Installed ${i.file}`); drawInstalled(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } }, "Install")))
      );
    } catch (e) {
      results.replaceChildren(h("div", { class: "error" }, e.message));
    }
  };
  modrinth.append(h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), search()) }, q, h("button", { type: "submit" }, "Search")), results);

  // GitHub
  let org = "";
  try { org = (await api("/settings")).githubOrg ?? ""; } catch { /* leave blank */ }
  const owner = h("input", { value: org, placeholder: "your-org or username", autocomplete: "off", spellcheck: "false" });
  const repoIn = h("input", { placeholder: "owner/repo", autocomplete: "off", spellcheck: "false" });
  const ghOut = h("div", {});
  async function showRelease(repo, into) {
    into.replaceChildren(h("span", { class: "muted" }, "Looking up the latest release…"));
    try {
      const r = await api(`/github/releases?repo=${encodeURIComponent(repo)}`);
      into.replaceChildren(
        h("div", { class: "muted" }, `Latest release ${r.tag}`),
        r.assets.length === 0 ? h("div", { class: "muted" }, "No .jar files attached to that release.") : h("div", {}, ...r.assets.map((a) => h("div", { class: "row" }, h("code", {}, a.name), !a.likely && h("span", { class: "tag" }, "probably not the plugin"), h("button", { class: "primary", onclick: async (e) => {
          e.target.disabled = true;
          try { const i = await api(`${base}/github/install`, { method: "POST", body: { repo, assetId: a.id } }); toast(`Installed ${i.file}`); drawInstalled(); } catch (err) { toast(err.message, true); e.target.disabled = false; }
        } }, "Install"))))
      );
    } catch (e) {
      into.replaceChildren(h("div", { class: "error" }, e.message));
    }
  }
  github.append(
    h("p", { class: "muted" }, "Uses your GitHub token from Settings, so private repos in your team work too."),
    h("form", { class: "row", onsubmit: async (e) => {
      e.preventDefault();
      ghOut.replaceChildren(h("p", { class: "muted" }, "Loading repos…"));
      try {
        const repos = await api(`/github/repos?owner=${encodeURIComponent(owner.value.trim())}`);
        ghOut.replaceChildren(...repos.map((r) => { const slot = h("div", {}); return h("div", { class: "panel" }, h("div", { class: "row spread" }, h("div", {}, h("b", {}, r.name), r.private && h("span", { class: "tag" }, "private"), h("div", { class: "muted" }, r.description ?? "")), h("button", { onclick: () => showRelease(r.full, slot) }, "Latest release")), slot); }));
        if (!repos.length) ghOut.replaceChildren(h("p", { class: "muted" }, "No repositories found."));
      } catch (err) { ghOut.replaceChildren(h("div", { class: "error" }, err.message)); }
    } }, owner, h("button", { type: "submit" }, "List repos")),
    h("form", { class: "row", onsubmit: (e) => { e.preventDefault(); const slot = h("div", {}); ghOut.prepend(slot); showRelease(repoIn.value.trim(), slot); } }, repoIn, h("button", { type: "submit" }, "Look up a repo")),
    ghOut
  );
  drawInstalled();
}
