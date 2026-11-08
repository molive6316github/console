import "./style.css";
import { h, api, hasUnsavedWork, setLeaveGuard } from "./ui.js";
import { serversView } from "./views/servers.js";
import { serverView } from "./views/server.js";
import { hostView } from "./views/host.js";
import { schedulesView } from "./views/schedules.js";
import { usersView } from "./views/users.js";
import { settingsView } from "./views/settings.js";
import { auditView } from "./views/audit.js";
import { accountView } from "./views/account.js";
import { updatesView } from "./views/updates.js";

const app = document.getElementById("app");
let me = null;
let cleanup = null;
let shownHash = null;
let updateInfo = null;
let navEl = null;
let content = null;

// ---- login -----------------------------------------------------------------
function renderLogin(message = "") {
  cleanup?.();
  cleanup = null;
  me = null;
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

// ---- layout + routing ---------------------------------------------------------
const isAdmin = () => me.role === "admin";

function navItems() {
  const items = [["#/", "Servers", "servers"]];
  if (isAdmin() || me.allServers) items.push(["#/host", "Host", "host"]);
  if (isAdmin()) {
    items.push(["#/schedules", "Schedules", "schedules"], ["#/users", "Users", "users"], ["#/settings", "Settings", "settings"], ["#/audit", "Audit", "audit"]);
    items.push(["#/updates", updateInfo?.ok && updateInfo.behind > 0 ? `Updates (${updateInfo.behind})` : "Updates", "updates"]);
  }
  items.push(["#/account", "Account", "account"]);
  return items;
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "s" && parts[1]) return { name: "server", id: parts[1], tab: parts[2] };
  return { name: parts[0] || "servers" };
}

const VIEWS = {
  servers: { render: serversView },
  host: { render: hostView, allowed: () => isAdmin() || me.allServers },
  schedules: { render: schedulesView, admin: true },
  users: { render: usersView, admin: true },
  settings: { render: settingsView, admin: true },
  audit: { render: auditView, admin: true },
  updates: { render: (box, ctx) => updatesView(box, { ...ctx, onInfo: (i) => ((updateInfo = i), drawNav()) }), admin: true },
  account: { render: accountView },
};

function drawNav() {
  if (!navEl) return;
  const route = parseRoute();
  const current = route.name === "server" ? "servers" : route.name;
  navEl.replaceChildren(...navItems().map(([href, label, key]) => h("a", { href, class: key === current ? "on" : "" }, label)));
}

function render() {
  cleanup?.();
  cleanup = null;
  setLeaveGuard(null);
  shownHash = location.hash;
  drawNav();
  content.replaceChildren();
  const route = parseRoute();
  if (route.name === "server") {
    cleanup = serverView(content, { me, id: route.id, tab: route.tab });
    return;
  }
  const v = VIEWS[route.name];
  if (!v || (v.admin && !isAdmin()) || (v.allowed && !v.allowed())) {
    location.hash = "#/";
    return;
  }
  const out = v.render(content, { me });
  if (typeof out === "function") cleanup = out;
}

function renderShell() {
  navEl = h("nav", {});
  content = h("main", {});
  app.replaceChildren(
    h(
      "div",
      { class: "wrap" },
      h(
        "header",
        {},
        h("a", { class: "brand", href: "#/" }, "Console"),
        navEl,
        h(
          "div",
          { class: "who" },
          h("span", {}, `${me.username} · ${me.role}`),
          h("button", { onclick: async () => (await api("/logout", { method: "POST", body: {} }).catch(() => {}), renderLogin()) }, "Sign out")
        )
      ),
      content
    )
  );
}

window.addEventListener("hashchange", () => {
  if (!me) return;
  if (hasUnsavedWork() && !confirm("You have unsaved changes. Leave without saving?")) {
    history.replaceState(null, "", shownHash || "#/");
    return;
  }
  render();
});
window.addEventListener("console:signed-out", () => me && renderLogin("Session expired, sign in again"));

async function boot() {
  try {
    me = await api("/me");
  } catch {
    return renderLogin();
  }
  renderShell();
  render();
  if (isAdmin()) {
    api("/update")
      .then((info) => ((updateInfo = info), drawNav()))
      .catch(() => {});
  }
}

boot();
