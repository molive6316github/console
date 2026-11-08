import "./panel.css";
import { h, api, toast, field, lifecycle } from "../ui.js";
import { consoleTab, filesTab, activityTab } from "../views/server.js";
import { playersTab, gameTab, pluginsTab, worldsTab } from "../views/minecraft.js";
import { followJob } from "../views/create.js";
import { accountView } from "../views/account.js";
import { settingsView } from "../views/settings.js";
import { updatesView } from "../views/updates.js";
import { overviewPage, startupPage, versionPage, peoplePage, joinPage } from "./pages.js";

// The Minecraft-mode app: one server, a sidebar, nothing generic.
export function startPanel(app, me, { signOut }) {
  const has = (p) => me.role === "admin" || (me.perms ?? []).includes(p);
  const isOwner = me.role === "admin";
  let server = null;
  let pageLife = null;
  let cleanup = null;
  const side = h("nav", { class: "side" });
  const main = h("main", { class: "pmain" });
  const head = h("div", { class: "phead" });
  const badge = h("span", { class: "badgebox" });
  let menuBtn;
  const shell = h("div", { class: "panelapp" },
    h("aside", { class: "sidebar", id: "sidebar" },
      h("div", { class: "logo" }, "⛏️ ", h("span", {}, "Console")),
      side,
      h("div", { class: "who" }, h("span", {}, `${me.username}${isOwner ? " · owner" : ""}`), h("button", { onclick: signOut }, "Sign out"))),
    h("div", { class: "pbody" },
      h("div", { class: "topbar" }, (menuBtn = h("button", { class: "burger", "aria-label": "Menu", onclick: () => shell.classList.toggle("open") }, "☰")), head, badge),
      main)
  );
  app.replaceChildren(shell);

  const PAGES = () => {
    const kind = server?.mc?.kind === "mods" ? "Mods" : "Plugins";
    return [
      { id: "overview", icon: "▣", label: "Overview", show: true, render: overviewPage },
      { id: "console", icon: "›_", label: "Console", show: has("console"), render: consoleTab },
      { id: "players", icon: "☺", label: "Players", show: has("players"), render: playersTab },
      { id: "plugins", icon: "✚", label: kind, show: has("plugins"), render: pluginsTab },
      { id: "files", icon: "▤", label: "Files", show: has("files") && server?.canEditFiles, render: filesTab },
      { id: "backups", icon: "⛁", label: "Backups & worlds", show: has("backups"), render: worldsTab },
      { sep: "Manage", show: has("settings") || has("startup") || has("versions") },
      { id: "settings", icon: "⚙", label: "Game settings", show: has("settings"), render: gameTab },
      { id: "startup", icon: "⚡", label: "Startup & memory", show: has("startup"), render: startupPage },
      { id: "version", icon: "⇄", label: "Version", show: has("versions"), render: versionPage },
      { sep: "Share", show: isOwner || has("activity") },
      { id: "people", icon: "☻", label: "People & invites", show: isOwner, render: peoplePage },
      { id: "join", icon: "⌁", label: "Join address & status page", show: isOwner, render: joinPage },
      { id: "activity", icon: "≡", label: "Activity", show: has("activity"), render: (box, o) => activityTab(box, o) },
      { sep: "Panel", show: true },
      { id: "panel-settings", icon: "☰", label: "Panel settings", show: isOwner, render: (box, o) => settingsView(box, o) },
      { id: "updates", icon: "↑", label: "Updates", show: isOwner, render: (box, o) => updatesView(box, o) },
      { id: "account", icon: "◉", label: "Account", show: true, render: (box, o) => accountView(box, o) },
    ].filter((p) => p.show);
  };

  const route = () => location.hash.replace(/^#\/?/, "").split("/")[0] || "overview";

  function drawSide(current) {
    side.replaceChildren(...PAGES().map((p) => (p.sep ? h("div", { class: "sep" }, p.sep) : h("a", { href: `#/${p.id}`, class: p.id === current ? "on" : "" }, h("span", { class: "ico" }, p.icon), p.label))));
  }

  async function loadServer() {
    const list = await api("/servers");
    const first = list.find((s) => s.mc) ?? list[0];
    server = first ? await api(`/servers/${encodeURIComponent(first.id)}`) : null;
  }

  function drawHead() {
    head.replaceChildren(
      server
        ? h("div", { class: "title" }, h("span", { class: `dot ${server.status}` }), h("strong", {}, server.name), h("span", { class: "muted small" }, server.busy ? "working…" : server.status === "up" ? "online" : server.status === "down" ? "offline" : server.status))
        : h("div", { class: "title" }, h("strong", {}, "Welcome"))
    );
  }

  async function render() {
    shell.classList.remove("open");
    pageLife?.stop();
    cleanup?.();
    cleanup = null;
    main.replaceChildren();
    try {
      await loadServer();
    } catch (e) {
      return void main.append(h("div", { class: "empty" }, e.message));
    }
    drawHead();
    if (!server) {
      drawSide("");
      if (!isOwner) return void main.append(h("div", { class: "empty" }, "There's no server here yet. Ask the owner to set it up."));
      return onboarding(main);
    }
    const pages = PAGES().filter((p) => p.id);
    const page = pages.find((p) => p.id === route()) ?? pages[0];
    drawSide(page.id);
    main.append(h("h1", { class: "ptitle" }, page.label));
    pageLife = lifecycle();
    const out = page.render(main, { server, me, life: pageLife, reload: render, param: undefined });
    if (typeof out === "function") cleanup = out;
    // keep the header light in sync without redrawing the page
    pageLife.every(async () => {
      try {
        server = await api(`/servers/${encodeURIComponent(server.id)}`);
        server.status && drawHead();
      } catch { /* ignore */ }
    }, 6000);
  }

  function onboarding(box) {
    const life = lifecycle();
    cleanup = () => life.stop();
    const name = h("input", { value: "My Minecraft Server", maxlength: 60 });
    const flavor = h("select", {}, h("option", { value: "paper" }, "Paper: fast, supports plugins (recommended)"), h("option", { value: "vanilla" }, "Vanilla: plain Minecraft"), h("option", { value: "purpur" }, "Purpur: Paper plus extra options"), h("option", { value: "fabric" }, "Fabric: for mods"));
    const ver = h("select", {}, h("option", {}, "Loading versions…"));
    const mem = h("select", {}, ...[[1024, "1 GB"], [2048, "2 GB (a few friends)"], [4096, "4 GB"], [6144, "6 GB"], [8192, "8 GB"]].map(([v, l]) => h("option", { value: v }, l)));
    mem.value = 2048;
    const eula = h("input", { type: "checkbox" });
    const out = h("div", {});
    const loadVers = async () => {
      ver.replaceChildren(h("option", {}, "Loading…"));
      try {
        const { versions } = await api(`/setup/minecraft/versions?flavor=${flavor.value}`);
        ver.replaceChildren(...versions.slice(0, 40).map((v) => h("option", { value: v }, v)));
      } catch (e) {
        ver.replaceChildren(h("option", { value: "" }, e.message));
      }
    };
    flavor.addEventListener("change", loadVers);
    loadVers();
    const go = h("button", { class: "primary big", onclick: async () => {
      if (!eula.checked) return toast("You need to accept the Minecraft EULA.", true);
      try {
        const r = await api("/setup/minecraft", { method: "POST", body: { name: name.value.trim(), flavor: flavor.value, version: ver.value, memoryMb: Number(mem.value), port: 25565, openFirewall: true, acceptEula: true } });
        go.disabled = true;
        followJob(out, r.jobId, { life, onDone: (j) => (j.status === "done" ? setTimeout(render, 800) : (go.disabled = false)) });
      } catch (e) {
        toast(e.message, true);
      }
    } }, "Create my server");
    box.append(
      h("div", { class: "panel welcome" },
        h("h2", {}, "Let's make your Minecraft server"),
        h("p", { class: "muted" }, "Pick a few things. Console downloads it, installs Java if needed, and gets it ready. You can change all of this later."),
        h("div", { class: "stack wide" },
          field("Server name", name), field("Type", flavor), field("Minecraft version", ver), field("Memory", mem),
          h("label", { class: "check" }, eula, h("span", {}, "I agree to the ", h("a", { href: "https://aka.ms/MinecraftEULA", target: "_blank", rel: "noopener" }, "Minecraft EULA"))),
          go),
        out)
    );
  }

  if (isOwner) {
    api("/update").then((u) => {
      if (u?.ok && u.behind > 0) badge.replaceChildren(h("a", { class: "updatebadge", href: "#/updates" }, u.latestVersion ? `Update ${u.latestVersion} ready` : "Update ready"));
    }).catch(() => {});
  }
  window.addEventListener("hashchange", onHash);
  function onHash() {
    if (!app.contains(shell)) return window.removeEventListener("hashchange", onHash);
    render();
  }
  render();
}
