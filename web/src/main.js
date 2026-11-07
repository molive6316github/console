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

function renderDashboard() {
  summaryEl = h("div", { class: "summary" }, "");
  gridEl = h("div", { class: "grid" });
  const auditBox = h("div", {});
  const header = h(
    "header",
    {},
    h("h1", {}, "Console"),
    h(
      "div",
      { class: "who" },
      h("span", {}, `${me.username} (${me.role})`),
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
  app.replaceChildren(h("div", { class: "wrap" }, header, summaryEl, gridEl, auditBox));
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
