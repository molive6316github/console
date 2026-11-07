import "./style.css";

const app = document.getElementById("app");
let me = null;
let servers = [];
let pollTimer = null;
let toastTimer = null;

// tiny DOM helper. Everything goes through textContent, so server data can't inject HTML.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function toast(msg, bad = false) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const t = h("div", { class: `toast${bad ? " bad" : ""}` }, msg);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), 4000);
}

// ---- login -----------------------------------------------------------------
function renderLogin(message = "") {
  clearInterval(pollTimer);
  const error = h("div", { class: "error" }, message);
  const user = h("input", { name: "username", placeholder: "Username", autocomplete: "username", required: true });
  const pass = h("input", { name: "password", type: "password", placeholder: "Password", autocomplete: "current-password", required: true });
  const form = h(
    "form",
    {
      class: "login",
      onsubmit: async (e) => {
        e.preventDefault();
        error.textContent = "";
        try {
          await api("/login", { method: "POST", body: { username: user.value, password: pass.value } });
          await boot();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    h("h1", {}, "Console"),
    user,
    pass,
    error,
    h("button", { class: "primary", type: "submit" }, "Sign in")
  );
  app.replaceChildren(form);
  user.focus();
}

// ---- dashboard ---------------------------------------------------------------
async function act(server, action) {
  if (action === "stop" && !confirm(`Stop ${server.name}?`)) return;
  if (action === "restart" && !confirm(`Restart ${server.name}?`)) return;
  server.busy = true;
  renderGrid();
  try {
    const r = await api(`/servers/${encodeURIComponent(server.id)}/${action}`, { method: "POST", body: {} });
    server.status = r.status;
    toast(`${server.name}: ${action} done`);
  } catch (err) {
    toast(`${server.name}: ${err.message}`, true);
  } finally {
    server.busy = false;
    await refresh();
  }
}

function card(s) {
  const disabled = !s.canAct || s.busy;
  return h(
    "div",
    { class: "card" },
    h("div", { class: "top" }, h("span", { class: `dot ${s.status}` }), h("span", { class: "name" }, s.name), h("span", { class: "type" }, s.type)),
    h("div", { class: "state" }, s.busy ? "working…" : s.status),
    s.error && h("div", { class: "err" }, s.error),
    s.canAct
      ? h(
          "div",
          { class: "actions" },
          h("button", { disabled: disabled || s.status === "up", onclick: () => act(s, "start") }, "Start"),
          h("button", { class: "danger", disabled: disabled || s.status === "down", onclick: () => act(s, "stop") }, "Stop"),
          h("button", { disabled, onclick: () => act(s, "restart") }, "Restart")
        )
      : h("div", { class: "state" }, me.role === "viewer" ? "View only" : "Read-only server")
  );
}

let gridEl = null;
let summaryEl = null;

function renderGrid() {
  if (!gridEl) return;
  const up = servers.filter((s) => s.status === "up").length;
  summaryEl.textContent = `${up} of ${servers.length} up`;
  gridEl.replaceChildren(...servers.map(card));
}

async function refresh() {
  try {
    const fresh = await api("/servers");
    // keep optimistic busy flags for actions this tab started
    const busyIds = new Set(servers.filter((s) => s.busy).map((s) => s.id));
    servers = fresh.map((s) => ({ ...s, busy: s.busy || busyIds.has(s.id) }));
    renderGrid();
  } catch (err) {
    if (err.status === 401) return renderLogin("Session expired, sign in again");
    toast(err.message, true);
  }
}

async function renderAudit(container) {
  if (me.role !== "admin") return;
  try {
    const rows = await api("/audit");
    container.replaceChildren(
      h("h2", {}, "Audit log"),
      h(
        "table",
        {},
        h("thead", {}, h("tr", {}, ["When (UTC)", "User", "Server", "Action", "Result", "Detail"].map((t) => h("th", {}, t)))),
        h(
          "tbody",
          {},
          rows.map((r) =>
            h(
              "tr",
              {},
              h("td", {}, r.ts),
              h("td", {}, r.username),
              h("td", {}, r.server_id ?? "-"),
              h("td", {}, r.action),
              h("td", { class: `ok-${r.ok}` }, r.ok ? "ok" : "failed"),
              h("td", {}, r.detail ?? "")
            )
          )
        )
      )
    );
  } catch { /* non-fatal */ }
}

// ---- account + updates panels ------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let panelBox = null;
let panelKind = null;
let updatesBtn = null;
let updateInfo = null;

function syncBadge() {
  if (!updatesBtn) return;
  updatesBtn.textContent = updateInfo?.ok && updateInfo.behind > 0 ? `Updates (${updateInfo.behind})` : "Updates";
}

function togglePanel(kind) {
  panelKind = panelKind === kind ? null : kind;
  renderPanel();
}

function renderPanel() {
  if (!panelBox) return;
  panelBox.replaceChildren();
  if (panelKind === "account") panelBox.append(accountPanel());
  if (panelKind === "updates") panelBox.append(updatesPanel());
}

function accountPanel() {
  const cur = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const again = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const msg = h("div", { class: "error" }, "");
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = "";
        if (next.value !== again.value) {
          msg.textContent = "New passwords don't match";
          return;
        }
        try {
          await api("/password", { method: "POST", body: { current: cur.value, next: next.value } });
          form.reset();
          toast("Password changed. Your other sessions were signed out.");
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    h("h2", {}, "Change password"),
    h("label", {}, "Current password", cur),
    h("label", {}, "New password (10+ characters)", next),
    h("label", {}, "Repeat new password", again),
    msg,
    h("button", { class: "primary", type: "submit" }, "Change password")
  );
  return h("div", { class: "panel" }, form);
}

// After an update the server restarts. Its bootId changes when the new process is up.
async function waitForRestart(oldBoot, statusEl) {
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      const m = res.ok ? await res.json() : null;
      if (m?.bootId && m.bootId !== oldBoot) {
        location.reload();
        return;
      }
    } catch {
      /* server is down mid-restart, keep waiting */
    }
    await sleep(1500);
  }
  statusEl.textContent = "Taking longer than expected. On the server run: sudo journalctl -u console -n 30";
}

const fmtSteps = (steps = []) =>
  steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.ok || !s.output ? "" : "\n" + s.output}`).join("\n");

function updatesPanel() {
  const status = h("div", { class: "state" }, "");
  const list = h("div", {});
  const log = h("pre", { class: "log" });
  const checkBtn = h("button", { onclick: () => runCheck(true) }, "Check for updates");
  const goBtn = h("button", { class: "primary", hidden: true, onclick: () => runUpdate() }, "Update now");

  async function runCheck(force) {
    status.textContent = "Checking…";
    list.replaceChildren();
    log.textContent = "";
    goBtn.hidden = true;
    try {
      const info = await api(`/update${force ? "?force=1" : ""}`);
      updateInfo = info;
      syncBadge();
      if (!info.supported) return void (status.textContent = info.error);
      if (!info.ok) return void (status.textContent = `Couldn't reach the repo: ${info.error}`);
      if (info.dirty) {
        return void (status.textContent = "This install has local changes to tracked files. Updating is blocked until they're reverted.");
      }
      if (info.ahead > 0) {
        return void (status.textContent = "This install has commits that aren't on the remote, so it can't fast-forward.");
      }
      if (info.behind === 0) return void (status.textContent = `Up to date (${info.current}).`);
      status.textContent = `${info.behind} new commit${info.behind === 1 ? "" : "s"}. Installed ${info.current}, latest ${info.latest}.`;
      list.replaceChildren(h("ul", {}, info.commits.map((c) => h("li", {}, c))));
      goBtn.hidden = false;
    } catch (err) {
      status.textContent = err.message;
    }
  }

  async function runUpdate() {
    if (!confirm("Update Console now? It pulls the latest code, rebuilds, and restarts. The page reloads when it's back.")) return;
    goBtn.disabled = checkBtn.disabled = true;
    status.textContent = "Updating… this can take a minute or two.";
    log.textContent = "";
    try {
      const r = await api("/update", { method: "POST", body: {} });
      log.textContent = fmtSteps(r.steps);
      if (!r.updated) {
        status.textContent = "Already up to date.";
      } else if (r.restarting) {
        status.textContent = `Updated ${r.from} → ${r.to}. Restarting…`;
        return void (await waitForRestart(me.bootId, status)); // reloads the page when the new process answers
      } else {
        status.textContent = `Updated ${r.from} → ${r.to}. Restart the process to load it (it isn't running under systemd).`;
      }
    } catch (err) {
      status.textContent = err.message;
      if (err.data?.steps) log.textContent = fmtSteps(err.data.steps);
    }
    goBtn.disabled = checkBtn.disabled = false;
  }

  runCheck(false);
  return h(
    "div",
    { class: "panel" },
    h("h2", {}, "Updates"),
    status,
    list,
    h("div", { class: "row" }, checkBtn, goBtn),
    log
  );
}

function renderDashboard() {
  summaryEl = h("div", { class: "summary" }, "");
  gridEl = h("div", { class: "grid" });
  const auditBox = h("div", {});
  updatesBtn = null;
  panelKind = null;
  panelBox = h("div", {});
  const header = h(
    "header",
    {},
    h("h1", {}, "Console"),
    h(
      "div",
      { class: "who" },
      h("span", {}, `${me.username} (${me.role}) · v${me.version}`),
      h("button", { onclick: () => togglePanel("account") }, "Account"),
      me.role === "admin" && (updatesBtn = h("button", { onclick: () => togglePanel("updates") }, "Updates")),
      me.role === "admin" && h("button", { onclick: () => renderAudit(auditBox) }, "Refresh audit"),
      h(
        "button",
        {
          onclick: async () => {
            await api("/logout", { method: "POST", body: {} }).catch(() => {});
            me = null;
            renderLogin();
          },
        },
        "Sign out"
      )
    )
  );
  app.replaceChildren(h("div", { class: "wrap" }, header, panelBox, summaryEl, gridEl, auditBox));
  if (me.role === "admin") {
    // quiet background check so the Updates button can show a count
    api("/update")
      .then((info) => {
        updateInfo = info;
        syncBadge();
      })
      .catch(() => {});
  }
  renderAudit(auditBox);
  refresh();
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (!document.hidden) refresh();
  }, 5000);
}

async function boot() {
  try {
    me = await api("/me");
    renderDashboard();
  } catch {
    renderLogin();
  }
}

boot();
