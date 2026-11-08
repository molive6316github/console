import { h, svg, api, toast, field, bytes } from "../ui.js";
import { followJob } from "../views/create.js";
import { act } from "../views/servers.js";

const base = (s) => `/servers/${encodeURIComponent(s.id)}/mc`;

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch {
    toast("Couldn't copy. Select it and press Ctrl+C.", true);
  }
}

// A small line chart. Fixed viewBox, so it scales without any inline styles (the CSP forbids them).
function spark(points, key, { max, unit = "", fmt = (v) => String(Math.round(v)) } = {}) {
  const W = 300, H = 70;
  const vals = points.map((p) => p[key]).filter((v) => v != null);
  const top = max ?? Math.max(10, ...vals) * 1.15;
  const box = svg("svg", { class: "spark", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${key} over the last hour` });
  box.append(svg("line", { class: "gridline", x1: 0, y1: H - 1, x2: W, y2: H - 1 }), svg("line", { class: "gridline", x1: 0, y1: H / 2, x2: W, y2: H / 2 }));
  if (vals.length > 1) {
    const step = W / Math.max(vals.length - 1, 1);
    const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(H - 2 - (Math.min(v, top) / top) * (H - 6)).toFixed(1)}`);
    box.append(svg("polygon", { class: "area", points: `0,${H} ${pts.join(" ")} ${W},${H}` }), svg("polyline", { class: "line", points: pts.join(" ") }));
  }
  const last = vals.at(-1);
  return { el: box, label: last == null ? "–" : `${fmt(last)}${unit}` };
}

// ---- Overview ---------------------------------------------------------------------
export function overviewPage(box, { server, me, life, reload }) {
  const power = h("div", { class: "power" });
  const addr = h("div", { class: "addr" });
  const facts = h("div", { class: "facts" });
  const graphs = h("div", { class: "graphs" });
  const people = h("div", { class: "panel" });
  box.append(h("div", { class: "hero panel" }, power, addr), facts, graphs, people);

  function drawPower() {
    const off = server.busy || !server.canAct;
    power.replaceChildren(
      h("div", { class: `state-pill ${server.status}` }, h("span", { class: `dot ${server.status}` }), server.busy ? "Working…" : { up: "Online", down: "Offline" }[server.status] ?? "Unknown"),
      server.canAct
        ? h(
            "div",
            { class: "btns" },
            h("button", { class: "big go", disabled: off || server.status === "up", onclick: () => act(server, "start", drawPower).then(reload) }, "▶ Start"),
            h("button", { class: "big", disabled: off || server.status === "down", onclick: () => act(server, "restart", drawPower).then(reload) }, "⟳ Restart"),
            h("button", { class: "big stop", disabled: off || server.status === "down", onclick: () => act(server, "stop", drawPower).then(reload) }, "■ Stop")
          )
        : h("div", { class: "muted" }, "You can look, but not control power.")
    );
  }

  let st = null;
  async function pullStatus() {
    try {
      st = await api(`${base(server)}/status`);
    } catch {
      return;
    }
    addr.replaceChildren(
      h("div", { class: "label" }, "Server address"),
      st.address
        ? h("div", { class: "row tight" }, h("code", { class: "bigaddr" }, st.address), h("button", { onclick: () => copyText(st.address) }, "Copy"))
        : h("div", { class: "muted" }, "Not set yet. Add a domain on the Join address page."),
      st.address ? h("div", { class: "muted small" }, st.domain ? "Paste this into Minecraft → Multiplayer → Add Server." : "Using your IP. A domain looks nicer: see Join address.") : null
    );
    facts.replaceChildren(
      fact("Players", st.online ? `${st.players.online} / ${st.players.max}` : "–"),
      fact("Version", st.online ? st.version : "–"),
      fact("World", st.level),
      fact("Uptime (24h)", server.uptime24h == null ? "–" : `${server.uptime24h}%`)
    );
    people.replaceChildren(
      h("h2", {}, "Online now"),
      st.online && st.players.names?.length ? h("div", { class: "chips" }, ...st.players.names.map((n) => h("span", { class: "chip" }, n))) : h("div", { class: "muted" }, st.online ? (st.players.online ? `${st.players.online} online (names are hidden by the server).` : "Nobody's on right now.") : "The server is offline."),
      st.online && st.motd ? h("p", { class: "muted small" }, `MOTD: ${st.motd}`) : null
    );
  }
  const fact = (k, v) => h("div", { class: "fact" }, h("div", { class: "k" }, k), h("div", { class: "v" }, v));

  async function pullStats() {
    let s;
    try {
      s = await api(`${base(server)}/stats?tps=${server.status === "up" ? 1 : 0}`);
    } catch {
      return;
    }
    const cpu = spark(s.points, "cpu", { max: Math.max(100, ...s.points.map((p) => p.cpu ?? 0)) , unit: "%" });
    const ram = spark(s.points, "ramMb", { unit: " MB" });
    const card = (title, c, note) => h("div", { class: "graph panel" }, h("div", { class: "row spread tight" }, h("strong", {}, title), h("span", { class: "now" }, c.label)), c.el, note && h("div", { class: "muted small" }, note));
    const tps = s.tps?.tps;
    graphs.replaceChildren(
      card("CPU", cpu, `${s.cores} core${s.cores === 1 ? "" : "s"}. 100% = one core fully busy.`),
      card("Memory", ram, "Memory the server process is using."),
      h(
        "div",
        { class: "graph panel" },
        h("div", { class: "row spread tight" }, h("strong", {}, "TPS"), h("span", { class: `now ${tps != null && tps < 18 ? "warn" : ""}` }, tps != null ? tps.toFixed(1) : "–")),
        h("div", { class: "tpsbar" }, svg("svg", { viewBox: "0 0 100 8", class: "tps" }, svg("rect", { class: "bg", x: 0, y: 0, width: 100, height: 8, rx: 4 }), svg("rect", { class: `fg ${tps != null && tps < 18 ? "warn" : ""}`, x: 0, y: 0, width: tps != null ? Math.max(2, (tps / 20) * 100) : 0, height: 8, rx: 4 }))),
        h("div", { class: "muted small" }, tps == null ? (server.status === "up" ? "Reading…" : "Start the server to see this.") : "20 is perfect. Under 18 means lag.")
      )
    );
  }

  drawPower();
  pullStatus();
  pullStats();
  life.every(() => { drawPower(); pullStatus(); }, 5000);
  life.every(pullStats, 15000);
}

// ---- Startup & memory -----------------------------------------------------------------
export async function startupPage(box, { server, life }) {
  let d;
  try {
    d = await api(`${base(server)}/startup`);
  } catch (e) {
    return void box.append(h("div", { class: "empty" }, e.message));
  }
  const gb = (mb) => (mb / 1024).toFixed(mb % 1024 ? 1 : 0);
  const mem = h("input", { type: "range", min: 512, max: Math.max(2048, Math.floor(((d.hostMemMb ?? 8192) * 0.85) / 256) * 256), step: 256, value: d.memoryMb });
  const memNum = h("output", { class: "memnum" }, `${gb(d.memoryMb)} GB`);
  mem.addEventListener("input", () => (memNum.textContent = `${gb(Number(mem.value))} GB`));
  const preset = h("select", {}, ...d.presets.map((p) => h("option", { value: p.id }, p.label)));
  preset.value = d.preset;
  const blurb = h("small", {}, d.presets.find((p) => p.id === d.preset)?.blurb);
  preset.addEventListener("change", () => (blurb.textContent = d.presets.find((p) => p.id === preset.value)?.blurb));
  const custom = h("textarea", { rows: 3, spellcheck: "false", placeholder: "-XX:+UseZGC\n-Xss512k" }, d.customFlags.join("\n"));
  const auto = h("input", { type: "checkbox", checked: d.autoRestart });
  const daily = h("input", { type: "time", value: d.dailyRestart ?? "04:00" });
  const dailyOn = h("input", { type: "checkbox", checked: Boolean(d.dailyRestart) });
  const msg = h("div", { class: "error" });
  async function save() {
    msg.textContent = "";
    try {
      await api(`${base(server)}/startup`, {
        method: "PUT",
        body: { memoryMb: Number(mem.value), preset: preset.value, customFlags: custom.value.split("\n").map((x) => x.trim()).filter(Boolean), autoRestart: auto.checked, dailyRestart: dailyOn.checked ? daily.value : null },
      });
      toast(server.status === "up" ? "Saved. Restart the server to use the new memory." : "Saved");
    } catch (e) {
      msg.textContent = e.message;
    }
  }
  box.append(
    h("div", { class: "panel" }, h("h2", {}, "Memory"), h("div", { class: "stack wide" }, h("div", { class: "row tight" }, mem, memNum), h("small", { class: "muted" }, d.hostMemMb ? `This machine has ${gb(d.hostMemMb)} GB total. Leave a few GB for the system.` : ""))),
    h("div", { class: "panel" }, h("h2", {}, "Java flags"), h("div", { class: "stack wide" }, field("Preset", preset, null), blurb, field("Extra flags (one per line)", custom, "Only safe tuning flags are accepted. Anything that could run code is refused."))),
    h("div", { class: "panel" }, h("h2", {}, "Keep it running"), h("div", { class: "stack wide" },
      h("label", { class: "check" }, auto, "Restart automatically if it crashes (up to 3 times in 30 minutes)"),
      h("label", { class: "check" }, dailyOn, "Restart every day at ", daily),
      h("small", { class: "muted" }, "Players get a 5 minute warning in chat before the daily restart."))),
    msg,
    h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Save changes"))
  );
}

// ---- Version ------------------------------------------------------------------------------
export async function versionPage(box, { server, life, reload }) {
  let d;
  try {
    d = await api(`${base(server)}/version`);
  } catch (e) {
    return void box.append(h("div", { class: "empty" }, e.message));
  }
  const flavor = h("select", {}, ...d.flavors.map((f) => h("option", { value: f.id }, f.label)));
  flavor.value = d.flavor;
  const ver = h("select", {});
  const fill = (list) => ver.replaceChildren(...list.map((v) => h("option", { value: v.id ?? v }, v.label ?? v.id ?? v)));
  fill(d.versions);
  if (d.current?.flavor === d.flavor) ver.value = d.current.version;
  flavor.addEventListener("change", async () => {
    ver.replaceChildren(h("option", {}, "Loading…"));
    try {
      fill((await api(`${base(server)}/version?flavor=${flavor.value}`)).versions);
    } catch (e) {
      toast(e.message, true);
    }
  });
  const confirmBox = h("input", { placeholder: `Type "${server.id}" to confirm`, autocomplete: "off" });
  const okType = h("input", { type: "checkbox" });
  const okDown = h("input", { type: "checkbox" });
  const out = h("div", {});
  const go = h("button", { class: "primary" }, "Switch version");
  go.onclick = async () => {
    if (server.status !== "down") return toast("Stop the server first.", true);
    try {
      const r = await api(`${base(server)}/version`, { method: "POST", body: { flavor: flavor.value, version: ver.value, confirm: confirmBox.value.trim(), acceptFlavorChange: okType.checked, acceptDowngrade: okDown.checked } });
      go.disabled = true;
      out.replaceChildren();
      followJob(out, r.jobId, { life, url: (id, since) => `${base(server)}/job/${id}?since=${since}`, onDone: () => (go.disabled = false) });
    } catch (e) {
      toast(e.message, true);
    }
  };
  box.append(
    h("div", { class: "panel" },
      h("h2", {}, "Server version"),
      h("p", { class: "muted" }, d.current ? `Currently ${d.flavors.find((f) => f.id === d.current.flavor)?.label ?? d.current.flavor} ${d.current.version}.` : "Console didn't set this server up, so it can't switch versions for you."),
      h("div", { class: "stack wide" },
        field("Server software", flavor), field("Minecraft version", ver),
        h("label", { class: "check" }, okType, "I'm changing server software (plugins/mods may stop working)"),
        h("label", { class: "check" }, okDown, "I'm going to an older version (worlds can break)"),
        confirmBox, go,
        h("small", { class: "muted" }, "The server must be stopped. A full backup is taken first, and the old server file is kept so you can go back.")
      ),
      out
    )
  );
  if (server.status !== "down") box.prepend(h("p", { class: "notice" }, "Stop the server before switching versions."));
}

// ---- People (users + invites) ---------------------------------------------------------------
export async function peoplePage(box, { server, me, life }) {
  const list = h("div", {});
  const invitesBox = h("div", {});
  const shown = h("div", {});
  const { perms, presets } = await api("/perms");

  const permGrid = (checked) => {
    const boxes = perms.map((p) => ({ p, el: h("input", { type: "checkbox", checked: checked.includes(p.id) }) }));
    return { boxes, el: h("div", { class: "permgrid" }, ...boxes.map(({ p, el }) => h("label", { class: `check perm${p.danger ? " danger" : ""}`, title: p.help }, el, h("span", {}, p.label, h("small", {}, p.help))))), value: () => boxes.filter((b) => b.el.checked).map((b) => b.p.id) };
  };

  // --- invite form
  const preset = h("select", {}, ...Object.entries(presets).map(([id, p]) => h("option", { value: id }, `${p.label}: ${p.help}`)), h("option", { value: "custom" }, "Custom: pick exactly what they can do"));
  const note = h("input", { placeholder: "Who is this for? (optional, e.g. Jake)", maxlength: 60 });
  const days = h("select", {}, h("option", { value: 1 }, "Expires in 1 day"), h("option", { value: 7, selected: true }, "Expires in 7 days"), h("option", { value: 30 }, "Expires in 30 days"));
  const grid = permGrid(["console"]);
  grid.el.hidden = true;
  preset.addEventListener("change", () => (grid.el.hidden = preset.value !== "custom"));
  const invite = async () => {
    try {
      const body = { serverId: server.id, note: note.value.trim(), days: Number(days.value) };
      if (preset.value === "custom") body.perms = grid.value();
      else body.preset = preset.value;
      const r = await api("/invites", { method: "POST", body });
      const link = `${location.origin}/#/invite/${r.token}`;
      shown.replaceChildren(
        h("div", { class: "panel good" },
          h("strong", {}, "Send them this link"),
          h("div", { class: "row tight" }, h("code", { class: "link" }, link), h("button", { onclick: () => copyText(link) }, "Copy")),
          h("small", { class: "muted" }, "It works once and you won't be able to see it again. Anyone with the link can make an account, so send it privately.")
        )
      );
      note.value = "";
      loadInvites();
    } catch (e) {
      toast(e.message, true);
    }
  };

  async function loadInvites() {
    const rows = await api(`/invites?server=${encodeURIComponent(server.id)}`).catch(() => []);
    const open = rows.filter((r) => r.state === "open");
    invitesBox.replaceChildren(
      h("h3", {}, "Open invites"),
      open.length
        ? h("ul", { class: "plain" }, ...open.map((r) => h("li", { class: "row spread" }, h("span", {}, `${presets[r.preset]?.label ?? "Custom"}${r.note ? ` · ${r.note}` : ""}`, h("small", { class: "muted" }, ` expires ${new Date(r.expiresAt).toLocaleDateString()}`)), h("button", { class: "danger", onclick: async () => { await api(`/invites/${r.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)); loadInvites(); } }, "Cancel"))))
        : h("div", { class: "muted" }, "None.")
    );
  }

  async function loadPeople() {
    const users = await api("/users");
    const here = users.filter((u) => u.role === "admin" || u.allServers || u.servers.includes(server.id));
    list.replaceChildren(
      ...here.map((u) => {
        if (u.role === "admin") return h("div", { class: "person" }, h("strong", {}, u.username), h("span", { class: "tag" }, "Owner"), u.username === me.username ? h("span", { class: "muted" }, " (you)") : null);
        const g = permGrid(u.perms);
        const pr = h("select", {}, h("option", { value: "" }, "Custom"), ...Object.entries(presets).map(([id, p]) => h("option", { value: id }, p.label)));
        const match = Object.entries(presets).find(([, p]) => p.perms.length === u.perms.length && p.perms.every((x) => u.perms.includes(x)));
        pr.value = match?.[0] ?? "";
        pr.addEventListener("change", () => {
          if (pr.value) for (const b of g.boxes) b.el.checked = presets[pr.value].perms.includes(b.p.id);
        });
        const det = h("details", {}, h("summary", {}, "Permissions"), g.el, h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
          try {
            await api(`/users/${u.id}`, { method: "PUT", body: { role: u.role, allServers: u.allServers, servers: u.servers, perms: g.value() } });
            toast(`Saved. ${u.username} will need to sign in again.`);
          } catch (e) { toast(e.message, true); }
        } }, "Save permissions")));
        return h("div", { class: "person" },
          h("div", { class: "row spread tight" }, h("div", {}, h("strong", {}, u.username), " ", pr), h("button", { class: "danger", onclick: async () => {
            if (!confirm(`Remove ${u.username}? They lose access immediately.`)) return;
            try { await api(`/users/${u.id}`, { method: "DELETE" }); toast("Removed"); loadPeople(); } catch (e) { toast(e.message, true); }
          } }, "Remove")),
          det
        );
      })
    );
  }

  box.append(
    h("div", { class: "panel" }, h("h2", {}, "People with access"), list),
    h("div", { class: "panel" }, h("h2", {}, "Invite someone"), h("div", { class: "stack wide" }, preset, grid.el, note, days, h("div", { class: "row" }, h("button", { class: "primary", onclick: invite }, "Create invite link"))), shown, invitesBox)
  );
  loadPeople().catch((e) => list.append(h("div", { class: "error" }, e.message)));
  loadInvites();
}

// ---- Domains: records to copy, live check, optional auto-create ---------------------------------
const copyCell = (text) => h("button", { class: "copycell", title: "Copy", onclick: () => copyText(text) }, h("code", {}, text), h("span", { class: "cp" }, "⧉"));
const STATE = { ok: ["✓ correct", "good"], wrong: ["✗ points elsewhere", "bad"], missing: ["… not added yet", "wait"], error: ["? couldn't check", "wait"] };

export async function joinPage(box, { server, life }) {
  const [j, pub] = await Promise.all([api(`${base(server)}/join`), api(`${base(server)}/public`).catch(() => null)]);
  const domain = h("input", { value: pub?.domain ?? "", placeholder: "play.example.com", autocomplete: "off", spellcheck: "false" });
  const srv = h("input", { type: "checkbox", checked: Boolean(pub?.srv) });
  const enabled = h("input", { type: "checkbox", checked: Boolean(pub?.enabled) });
  const names = h("input", { type: "checkbox", checked: Boolean(pub?.names) });
  const msg = h("div", { class: "error" });
  const save = async () => {
    msg.textContent = "";
    try {
      await api(`${base(server)}/public`, { method: "PUT", body: { enabled: enabled.checked, names: names.checked, domain: domain.value.trim(), srv: srv.checked } });
      toast("Saved");
      location.reload();
    } catch (e) {
      msg.textContent = e.message;
    }
  };
  const dnsBox = h("div", { class: "panel" }, h("h2", {}, "DNS records"), h("div", { class: "muted" }, "Loading…"));
  const provBox = h("div", { class: "panel" });
  box.append(
    h("div", { class: "panel" },
      h("h2", {}, "Join address"),
      j.address ? h("div", { class: "row tight" }, h("code", { class: "bigaddr" }, j.address), h("button", { onclick: () => copyText(j.address) }, "Copy")) : h("p", { class: "muted" }, "No address yet."),
      h("div", { class: "stack wide" }, field("Your domain (optional)", domain, "Like play.yourname.com. Save it and the exact DNS records appear below, ready to copy."), h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Save domain")))),
    dnsBox,
    provBox,
    h("div", { class: "panel" },
      h("h2", {}, "Public status page"),
      h("p", { class: "muted" }, "A page anyone can open (no login) showing whether the server is online and how many are playing. Share it in your Discord."),
      h("div", { class: "stack wide" },
        h("label", { class: "check" }, enabled, "Turn on the public page"),
        h("label", { class: "check" }, names, "Show player names"),
        pub?.enabled ? h("div", { class: "row tight" }, h("code", { class: "link" }, `${location.origin}/status.html`), h("button", { onclick: () => copyText(`${location.origin}/status.html`) }, "Copy")) : null)),
    msg,
    h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Save"))
  );
  void srv;

  async function drawProvider(info) {
    const p = info.provider;
    const g = info.guess;
    const kind = h("select", {}, h("option", { value: "cloudflare" }, "Cloudflare"), h("option", { value: "vercel" }, "Vercel"));
    kind.value = g?.kind ?? "cloudflare";
    const token = h("input", { type: "password", placeholder: "Paste API token", autocomplete: "off" });
    const team = h("input", { placeholder: "Team ID (only if the domain is on a Vercel team)", autocomplete: "off" });
    const help = h("p", { class: "muted small" });
    const setHelp = () => (help.textContent = kind.value === "cloudflare" ? "Cloudflare: My Profile → API Tokens → Create Token → \"Edit zone DNS\" template → pick your domain. Copy the token." : "Vercel: Account Settings → Tokens → Create. Console only touches DNS records.");
    kind.addEventListener("change", setHelp);
    setHelp();
    provBox.replaceChildren(
      h("h2", {}, "Add the records for me"),
      g?.name ? h("p", { class: "muted" }, `Your domain's DNS is run by ${g.name}.${g.kind ? "" : " Console can't add records there automatically yet, so use the copy buttons above (it takes a minute)."}`) : null,
      p
        ? h("div", {}, h("p", {}, `Connected to ${p.kind} (token ending ${p.tokenTail}).`),
            h("div", { class: "row" },
              h("button", { class: "primary", onclick: async () => { try { const r = await api("/dns/apply", { method: "POST", body: {} }); const bad = r.results.filter((x) => x.error); toast(bad.length ? bad[0].error : "Records are in place. It can take a few minutes to show up.", Boolean(bad.length)); drawDns(); } catch (e) { toast(e.message, true); } } }, "Add / fix all records now"),
              h("button", { onclick: async () => { await api("/dns/provider", { method: "DELETE" }); load(); } }, "Disconnect")))
        : h("div", { class: "stack wide" }, field("Provider", kind), token, kind.value === "vercel" ? team : null, help,
            h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => { try { await api("/dns/provider", { method: "PUT", body: { kind: kind.value, token: token.value.trim(), teamId: team.value.trim() } }); toast("Connected"); load(); } catch (e) { toast(e.message, true); } } }, "Connect")),
            h("small", { class: "muted" }, "The token is stored on this server only and can edit DNS, so keep it to a DNS-only token. You can disconnect any time."))
    );
  }

  async function drawDns() {
    let c;
    try { c = await api("/dns/check"); } catch (e) { return void dnsBox.replaceChildren(h("h2", {}, "DNS records"), h("div", { class: "error" }, e.message)); }
    if (!c.hosts.length) return void dnsBox.replaceChildren(h("h2", {}, "DNS records"), h("p", { class: "muted" }, "Save a domain above and the records to create show up here."));
    dnsBox.replaceChildren(
      h("h2", {}, "DNS records"),
      h("p", { class: "muted" }, "Add these at the company where you bought the domain (its DNS page). Click any value to copy it. This page checks again every few seconds and ticks them off."),
      ...c.hosts.map((x) => h("table", { class: "dns" },
        h("thead", {}, h("tr", {}, ...["Type", "Name / Host", "Value / Points to", ""].map((t) => h("th", {}, t)))),
        h("tbody", {}, ...x.records.map((r) => {
          const [label, cls] = STATE[r.check.state] ?? STATE.error;
          return h("tr", {}, h("td", {}, h("strong", {}, r.type)), h("td", {}, copyCell(r.name)), h("td", {}, copyCell(r.value)), h("td", { class: `st ${cls}` }, label, r.check.found ? h("small", { class: "muted" }, ` now: ${r.check.found}`) : null));
        })))),
      c.allGood ? h("p", { class: "jobstatus good" }, "✓ All records are live. You're done.") : h("p", { class: "muted small" }, "DNS changes can take a few minutes (rarely longer). The name field wants just what's shown; some providers want it relative (play) and some full. If yours wants relative, drop the domain part.")
    );
    return c.allGood;
  }

  async function load() {
    const info = await api("/dns").catch(() => null);
    if (info) drawProvider(info);
    drawDns();
  }
  load();
  life.every(async () => { if (document.hidden) return; await drawDns(); }, 8000);
}
