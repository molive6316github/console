import { h, api, toast, field, lifecycle, sleep } from "../ui.js";
import { atLeast, getLevel } from "../level.js";

const ICONS = { minecraft: "⛏️", "git-app": "🤖", "static-site": "🌐", docker: "🐳" };

// Follows a background job (downloads, installs) and shows its output live.
export function followJob(box, jobId, { life, onDone } = {}) {
  const status = h("div", { class: "jobstatus" }, "Working…");
  const log = h("pre", { class: "log console", tabindex: "0", "aria-label": "Progress" });
  const result = h("div", {});
  box.append(status, log, result);
  let since = 0;
  (async () => {
    for (;;) {
      if (life?.dead) return;
      let j;
      try {
        j = await api(`/jobs/${jobId}?since=${since}`);
      } catch (err) {
        status.textContent = err.message;
        status.className = "jobstatus bad";
        return;
      }
      if (j.log) {
        const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
        log.append(document.createTextNode(j.log));
        if (pinned) log.scrollTop = log.scrollHeight;
      }
      since = j.offset;
      if (j.status === "running") {
        status.textContent = `${j.title}…`;
        await sleep(1000);
        continue;
      }
      status.textContent = j.status === "done" ? `✓ ${j.title}: done` : `✗ ${j.title}: ${j.error}`;
      status.className = `jobstatus ${j.status === "done" ? "good" : "bad"}`;
      onDone?.(j, result);
      return;
    }
  })();
}

function readiness(t, st) {
  if (!st) return [];
  const need = [];
  if (t.id === "docker" && !st.docker) need.push("Docker isn't installed on this server yet.");
  if (t.id === "git-app" && !st.git) need.push("git isn't installed.");
  if (t.id === "static-site" && !st.caddy) need.push("Needs the Caddy web server. Re-run the installer with a domain to set it up.");
  if (t.id === "minecraft" && !st.java && !st.sudo) need.push("Java isn't installed and Console can't install it (no passwordless sudo).");
  return need;
}

export function createView(box, { me, param }) {
  const life = lifecycle();
  if (param && param.startsWith("job-")) {
    jobPage(box, param.slice(4), life);
    return () => life.stop();
  }
  load(box, param, life, me);
  return () => life.stop();
}

function jobPage(box, id, life) {
  box.append(h("p", { class: "crumb" }, h("a", { href: "#/create" }, "← Create")), h("div", { class: "titlebar" }, h("h1", {}, "Setting things up")));
  const panel = h("div", { class: "panel" });
  box.append(panel);
  followJob(panel, id, {
    life,
    onDone: (j, out) => {
      if (j.status === "done" && j.result?.serverId) {
        out.append(
          h("div", { class: "row" }, h("a", { class: "btn primary", href: `#/s/${encodeURIComponent(j.result.serverId)}/console` }, "Open it"), h("a", { class: "btn", href: "#/" }, "All servers")),
          j.result.note && h("p", { class: "notice" }, j.result.note)
        );
      } else if (j.status === "failed") {
        out.append(h("div", { class: "row" }, h("a", { class: "btn", href: "#/create" }, "Back")));
      }
    },
  });
}

async function load(box, param, life, me) {
  let catalog, st;
  try {
    [catalog, st] = await Promise.all([api("/setup/catalog"), api("/setup/status").catch(() => null)]);
  } catch (err) {
    return void box.append(h("div", { class: "error" }, err.message));
  }
  // Minecraft-mode installs keep Create focused: just Minecraft, until you switch to Advanced.
  const mcOnly = me.mode === "minecraft" && !atLeast("advanced");
  if (mcOnly) catalog = catalog.filter((x) => x.id === "minecraft");
  const t = param && catalog.find((x) => x.id === param);
  if (t) return void form(box, t, st, life);

  box.append(
    h("div", { class: "titlebar" }, h("h1", {}, "Create"), h("span", { class: "muted" }, "Pick what you want. Console does the rest.")),
    h(
      "div",
      { class: "grid" },
      ...catalog.map((x) => {
        const problems = readiness(x, st);
        return h(
          "a",
          { class: "card pick", href: `#/create/${x.id}` },
          h("div", { class: "top" }, h("span", { class: "big" }, ICONS[x.id] ?? "📦"), h("span", { class: "name" }, x.title), h("span", { class: "type" }, x.category)),
          h("div", { class: "muted" }, x.blurb),
          problems.length > 0 && h("div", { class: "err" }, problems[0])
        );
      }),
      h("a", { class: "card pick", href: "#/discover" }, h("div", { class: "top" }, h("span", { class: "big" }, "🔎"), h("span", { class: "name" }, "Find what's already here")), h("div", { class: "muted" }, "Scan this machine for tmux sessions, Docker containers and services, and add them to Console.")),
      atLeast("standard") && h("a", { class: "card pick", href: "#/new" }, h("div", { class: "top" }, h("span", { class: "big" }, "🛠️"), h("span", { class: "name" }, "Add one by hand")), h("div", { class: "muted" }, "You already know the command, container or service. Point Console at it."))
    ),
    st && !st.sudo && h("p", { class: "notice" }, `Console runs as "${st.user}" and doesn't have passwordless sudo, so setups that need to install packages (like Java) or open a firewall port will ask you to do that step yourself.`)
  );
}

function form(box, t, st, life) {
  const values = {};
  const rows = new Map(); // key -> { wrap, field }
  const controls = new Map();
  const msg = h("div", { class: "error" });
  let showMore = false;

  const visibleAt = (f) => (f.level === "advanced" ? atLeast("advanced") || showMore : f.level === "standard" ? atLeast("standard") || showMore : true);
  const shown = (f) => visibleAt(f) && (!f.showWhen || Object.entries(f.showWhen).every(([k, v]) => values[k] === v));

  function refresh() {
    for (const f of t.fields) rows.get(f.key).hidden = !shown(f);
    more.textContent = showMore ? "Hide extra options" : "More options";
    more.hidden = atLeast("advanced") || !t.fields.some((f) => f.level);
  }

  async function loadVersions(sel) {
    sel.replaceChildren(h("option", { value: "" }, "Loading versions…"));
    try {
      const { versions } = await api(`/setup/minecraft/versions?flavor=${encodeURIComponent(values.flavor ?? "paper")}`);
      sel.replaceChildren(...versions.map((v, i) => h("option", { value: v }, i === 0 ? `${v} (newest)` : v)));
      values.version = versions[0] ?? "";
    } catch (err) {
      sel.replaceChildren(h("option", { value: "" }, "Couldn't load versions"));
      msg.textContent = err.message;
    }
  }

  for (const f of t.fields) {
    let ctl;
    const set = (v) => {
      values[f.key] = v;
      refresh();
    };
    if (f.type === "select" || f.type === "version") {
      ctl = h("select", { onchange: (e) => (set(e.target.value), f.key === "flavor" && controls.has("version") && loadVersions(controls.get("version"))) }, ...(f.options ?? []).map((o) => h("option", { value: o.value }, o.label)));
      if (f.default !== undefined) ctl.value = f.default;
      values[f.key] = f.default ?? ctl.value;
    } else if (f.type === "checkbox") {
      ctl = h("input", { type: "checkbox", checked: f.default === true, onchange: (e) => set(e.target.checked) });
      values[f.key] = f.default === true;
    } else if (f.type === "textarea") {
      ctl = h("textarea", { rows: "4", spellcheck: "false", autocomplete: "off", placeholder: f.placeholder ?? "", oninput: (e) => set(e.target.value) });
    } else {
      ctl = h("input", { type: f.type === "number" ? "number" : "text", value: f.default ?? "", placeholder: f.placeholder ?? "", autocomplete: "off", spellcheck: "false", oninput: (e) => set(e.target.value) });
      values[f.key] = f.default ?? "";
    }
    controls.set(f.key, ctl);
    const wrap = f.type === "checkbox" ? h("label", { class: "field check" }, ctl, h("span", {}, f.label), f.help && h("small", {}, f.help)) : field(f.label, ctl, f.help);
    rows.set(f.key, wrap);
  }

  const more = h("button", { type: "button", class: "linklike", onclick: () => ((showMore = !showMore), refresh()) }, "More options");
  const go = h("button", { class: "primary", type: "submit" }, t.id === "minecraft" ? "Create server" : "Set it up");
  const formEl = h(
    "form",
    {
      class: "stack wide",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = "";
        go.disabled = true;
        const body = {};
        for (const f of t.fields) if (shown(f)) body[f.key] = values[f.key];
        try {
          const { jobId } = await api(`/setup/${t.id}`, { method: "POST", body });
          location.hash = `#/create/job-${jobId}`;
        } catch (err) {
          msg.textContent = err.message;
          go.disabled = false;
        }
      },
    },
    ...t.fields.map((f) => rows.get(f.key)),
    more,
    msg,
    h("div", { class: "row" }, go, h("a", { class: "btn", href: "#/create" }, "Cancel"))
  );

  box.append(h("p", { class: "crumb" }, h("a", { href: "#/create" }, "← Create")), h("div", { class: "titlebar" }, h("h1", {}, t.title)), h("p", { class: "muted" }, t.blurb));
  const problems = readiness(t, st);
  if (problems.length) box.append(h("p", { class: "notice" }, problems.join(" ")));
  if (t.id === "git-app" && st && !st.githubToken) box.append(h("p", { class: "muted" }, "Private repo? Save a GitHub token in ", h("a", { href: "#/settings" }, "Settings"), " first."));
  box.append(h("div", { class: "panel" }, formEl));
  refresh();
  if (controls.has("version")) loadVersions(controls.get("version"));
  if (getLevel() === "simple") formEl.querySelector("input,select,textarea")?.focus();
}
