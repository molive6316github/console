import { h, api, toast, dot, lifecycle, bytes, when, sqlTime, setLeaveGuard } from "../ui.js";
import { actionButtons, uptimeText } from "./servers.js";
import { serverForm } from "./serverForm.js";
import { followJob } from "./create.js";
import { playersTab, gameTab, pluginsTab } from "./minecraft.js";

const TABS = [
  { id: "console", label: "Console", show: (s) => s.caps.logs || s.canSend },
  { id: "players", label: "Players", show: (s) => Boolean(s.mc) && s.canSend },
  { id: "game", label: "Game settings", show: (s, me) => Boolean(s.mc) && me.role === "admin" },
  { id: "plugins", label: (s) => (s.mc?.kind === "mods" ? "Mods" : "Plugins"), show: (s, me) => Boolean(s.mc) && me.role === "admin" && !me.safeMode },
  { id: "files", label: "Files", show: (s) => s.canEditFiles },
  { id: "backups", label: "Backups", show: (s) => s.canBackup },
  { id: "activity", label: "Activity", show: (_s, me) => me.role === "admin" },
  { id: "settings", label: "Settings", show: (_s, me) => me.role === "admin" },
];

export function serverView(box, { me, id, tab }) {
  const life = lifecycle();
  let server = null;
  let tabLife = null;
  const head = h("div", {});
  const tabsBar = h("div", { class: "tabs" });
  const body = h("div", {});
  box.append(h("p", { class: "crumb" }, h("a", { href: "#/" }, "← Servers")), head, tabsBar, body);

  function drawHead() {
    head.replaceChildren(
      h(
        "div",
        { class: "titlebar" },
        h("h1", {}, dot(server.status), " ", server.name, h("span", { class: "type" }, server.type)),
        actionButtons(server, () => load(false))
      ),
      h("div", { class: "state" }, server.busy ? "working…" : `${server.status} · ${uptimeText(server)}`),
      h("div", { class: "err", hidden: !server.error }, server.error ?? "")
    );
  }

  function drawTabs() {
    const visible = TABS.filter((t) => t.show(server, me));
    tabsBar.replaceChildren(...visible.map((t) => h("a", { class: `tab${t.id === currentTab ? " on" : ""}`, href: `#/s/${encodeURIComponent(id)}/${t.id}` }, typeof t.label === "function" ? t.label(server) : t.label)));
  }

  let currentTab = null;
  function drawTab() {
    const visible = TABS.filter((t) => t.show(server, me));
    const want = visible.find((t) => t.id === tab) ?? visible[0];
    if (want?.id === currentTab) return;
    currentTab = want?.id ?? null;
    tabLife?.stop();
    body.replaceChildren();
    drawTabs();
    if (!want) return void body.append(h("div", { class: "empty" }, "Nothing to show for this server with your permissions."));
    tabLife = lifecycle();
    const view = { console: consoleTab, players: playersTab, game: gameTab, plugins: pluginsTab, files: filesTab, backups: backupsTab, activity: activityTab, settings: settingsTab }[want.id];
    view(body, { server, me, life: tabLife, reload: () => load(true) });
  }

  async function load(redraw) {
    try {
      server = await api(`/servers/${encodeURIComponent(id)}`);
    } catch (err) {
      if (err.status === 404) {
        box.replaceChildren(h("div", { class: "empty" }, "That server doesn't exist (or isn't shared with you). ", h("a", { href: "#/" }, "Back to servers")));
        life.stop();
      }
      return;
    }
    drawHead();
    if (redraw) currentTab = null;
    drawTab();
  }

  load(false);
  life.every(() => load(false), 5000);
  return () => {
    life.stop();
    tabLife?.stop();
  };
}

// ---- console: live log tail + command box ---------------------------------------------
function consoleTab(box, { server, life }) {
  const pre = h("pre", { class: "log console", tabindex: "0", "aria-label": "Server output" });
  const status = h("span", { class: "muted" }, "loading…");
  const paused = h("input", { type: "checkbox" });
  const lines = h("select", {}, [200, 500, 1000, 2000].map((n) => h("option", { value: n }, `${n} lines`)));
  let last = null;

  async function pull() {
    if (paused.checked) return;
    try {
      const { text } = await api(`/servers/${encodeURIComponent(server.id)}/logs?lines=${lines.value}`);
      status.textContent = `live · updated ${new Date().toLocaleTimeString()}`;
      if (text === last) return;
      last = text;
      const stick = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40; // only follow the tail if you're at the bottom
      pre.textContent = text || "(no output yet)";
      if (stick) pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      status.textContent = err.message;
    }
  }

  const parts = [h("div", { class: "row spread" }, status, h("div", { class: "row" }, lines, h("label", { class: "check" }, paused, "Pause"))), pre];

  if (server.canSend) {
    const input = h("input", { class: "grow", placeholder: "Type a command, press Enter", autocomplete: "off", spellcheck: "false", maxlength: "1000" });
    const history = [];
    let hi = 0;
    const form = h(
      "form",
      {
        class: "row cmd",
        onsubmit: async (e) => {
          e.preventDefault();
          const text = input.value.trim();
          if (!text) return;
          try {
            await api(`/servers/${encodeURIComponent(server.id)}/command`, { method: "POST", body: { text } });
            history.push(text);
            hi = history.length;
            input.value = "";
            setTimeout(pull, 400);
          } catch (err) {
            toast(err.message, true);
          }
        },
      },
      h("span", { class: "prompt" }, ">"),
      input,
      h("button", { class: "primary", type: "submit" }, "Send")
    );
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" && history.length) {
        hi = Math.max(0, hi - 1);
        input.value = history[hi];
        e.preventDefault();
      } else if (e.key === "ArrowDown" && history.length) {
        hi = Math.min(history.length, hi + 1);
        input.value = history[hi] ?? "";
        e.preventDefault();
      }
    });
    parts.push(form, h("p", { class: "muted" }, "Commands are typed into the running server exactly as written, and every one is saved in the audit log."));
  }
  box.append(...parts);
  lines.addEventListener("change", () => {
    last = null;
    pull();
  });
  pull().then(() => (pre.scrollTop = pre.scrollHeight));
  life.every(pull, 2000);
}

// ---- files -----------------------------------------------------------------------------
function filesTab(box, { server, life }) {
  const base = `/servers/${encodeURIComponent(server.id)}`;
  const crumbs = h("div", { class: "crumbs" });
  const list = h("div", {});
  const editor = h("div", {});
  box.append(crumbs, list, editor);
  let dir = "";
  let dirty = () => false;

  const guard = () => !dirty() || confirm("You have unsaved changes. Discard them?");
  const join = (a, b) => (a ? `${a}/${b}` : b);

  function drawCrumbs() {
    const parts = dir ? dir.split("/") : [];
    crumbs.replaceChildren(
      h("a", { href: "#", onclick: (e) => (e.preventDefault(), guard() && open("")) }, "files"),
      ...parts.flatMap((p, i) => [" / ", h("a", { href: "#", onclick: (e) => (e.preventDefault(), guard() && open(parts.slice(0, i + 1).join("/"))) }, p)])
    );
  }

  async function open(path) {
    try {
      const r = await api(`${base}/files?path=${encodeURIComponent(path)}`);
      dir = r.path;
      editor.replaceChildren();
      dirty = () => false;
      drawCrumbs();
      list.replaceChildren(
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["Name", "Size", "Modified"].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            dir && h("tr", {}, h("td", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), open(dir.split("/").slice(0, -1).join("/"))) }, "..")), h("td"), h("td")),
            r.entries.map((en) =>
              h(
                "tr",
                {},
                h("td", {}, h("a", { href: "#", onclick: (e) => (e.preventDefault(), en.type === "dir" ? open(join(dir, en.name)) : edit(join(dir, en.name))) }, en.type === "dir" ? `${en.name}/` : en.name)),
                h("td", {}, en.type === "dir" ? "" : bytes(en.size)),
                h("td", {}, when(en.mtime))
              )
            )
          )
        ),
        h("div", { class: "row" }, h("button", { onclick: newFile }, "New file"))
      );
    } catch (err) {
      toast(err.message, true);
    }
  }

  function newFile() {
    const name = h("input", { placeholder: "filename.txt", required: true });
    editor.replaceChildren(
      h("form", { class: "row", onsubmit: (e) => (e.preventDefault(), name.value.trim() && edit(join(dir, name.value.trim()), true)) }, name, h("button", { type: "submit" }, "Create")),
    );
    name.focus();
  }

  async function edit(path, isNew = false) {
    if (!guard()) return;
    let file = { path, content: "", mtime: null };
    if (!isNew) {
      try {
        file = await api(`${base}/file?path=${encodeURIComponent(path)}`);
      } catch (err) {
        return void toast(err.message, true);
      }
    }
    const area = h("textarea", { class: "code", spellcheck: "false", wrap: "off", "aria-label": `Editing ${path}` });
    area.value = file.content;
    let saved = file.content;
    let mtime = file.mtime;
    dirty = () => area.value !== saved;
    const note = h("span", { class: "muted" }, isNew ? "new file" : "");
    async function save() {
      try {
        const r = await api(`${base}/file`, { method: "PUT", body: { path, content: area.value, mtime } });
        saved = area.value;
        mtime = r.mtime;
        note.textContent = `saved ${new Date().toLocaleTimeString()}`;
        toast(`Saved ${path}. Restart the server for it to take effect.`);
      } catch (err) {
        toast(err.message, true);
      }
    }
    area.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
      if (e.key === "Tab" && !e.shiftKey) {
        e.preventDefault();
        area.setRangeText("  ", area.selectionStart, area.selectionEnd, "end");
      }
    });
    editor.replaceChildren(
      h("div", { class: "row spread" }, h("strong", {}, path), note),
      area,
      h("div", { class: "row" }, h("button", { class: "primary", onclick: save }, "Save"), h("button", { onclick: () => guard() && (editor.replaceChildren(), (dirty = () => false)) }, "Close"), h("span", { class: "muted" }, "Ctrl+S saves"))
    );
    area.focus();
  }

  const onUnload = (e) => {
    if (dirty()) e.preventDefault();
  };
  window.addEventListener("beforeunload", onUnload);
  setLeaveGuard(() => dirty());
  life.onStop(() => {
    window.removeEventListener("beforeunload", onUnload);
    setLeaveGuard(null);
  });
  open("");
}

// ---- backups ---------------------------------------------------------------------------
function backupsTab(box, { server }) {
  const base = `/servers/${encodeURIComponent(server.id)}/backups`;
  const list = h("div", {});
  const btn = h("button", { class: "primary" }, "Back up now");
  async function load() {
    try {
      const rows = await api(base);
      list.replaceChildren(
        rows.length
          ? h(
              "table",
              {},
              h("thead", {}, h("tr", {}, ["Created", "Size", ""].map((t) => h("th", {}, t)))),
              h(
                "tbody",
                {},
                rows.map((b) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, when(b.created)),
                    h("td", {}, bytes(b.size)),
                    h(
                      "td",
                      { class: "right" },
                      h("a", { class: "btn", href: `/api${base}/${b.name}`, download: "" }, "Download"),
                      " ",
                      h("button", { class: "danger", onclick: async () => confirm("Delete this backup?") && (await api(`${base}/${b.name}`, { method: "DELETE" }).then(load, (e) => toast(e.message, true))) }, "Delete")
                    )
                  )
                )
              )
            )
          : h("div", { class: "empty" }, "No backups yet.")
      );
    } catch (err) {
      toast(err.message, true);
    }
  }
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "Backing up…";
    try {
      const r = await api(base, { method: "POST", body: {} });
      toast(`Backup ${r.name} (${bytes(r.size)})`);
    } catch (err) {
      toast(err.message, true);
    }
    btn.disabled = false;
    btn.textContent = "Back up now";
    load();
  });
  box.append(
    h("div", { class: "row spread" }, h("p", { class: "muted" }, "A compressed copy of this server's files folder, kept on this machine. Restore by downloading it and unpacking it yourself. Schedule these under Schedules."), btn),
    list
  );
  load();
}

// ---- activity ---------------------------------------------------------------------------
function activityTab(box, { server }) {
  api(`/audit?server=${encodeURIComponent(server.id)}&limit=100`).then((rows) =>
    box.append(
      rows.length
        ? h(
            "table",
            {},
            h("thead", {}, h("tr", {}, ["When", "Who", "What", "Result", "Detail"].map((t) => h("th", {}, t)))),
            h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, sqlTime(r.ts)), h("td", {}, r.username), h("td", {}, r.action), h("td", { class: `ok-${r.ok}` }, r.ok ? "ok" : "failed"), h("td", {}, r.detail ?? ""))))
          )
        : h("div", { class: "empty" }, "Nothing yet.")
    )
  );
}

// ---- settings (edit / remove) -------------------------------------------------------------
async function settingsTab(box, { server, reload, life }) {
  const git = await api(`/servers/${encodeURIComponent(server.id)}/git`).catch(() => null);
  if (git) {
    const out = h("div", {});
    const btn = h("button", { class: "primary", onclick: async () => {
      btn.disabled = true;
      out.replaceChildren();
      try {
        const { jobId } = await api(`/servers/${encodeURIComponent(server.id)}/git-update`, { method: "POST", body: {} });
        followJob(out, jobId, { life, onDone: () => { btn.disabled = false; } });
      } catch (err) { toast(err.message, true); btn.disabled = false; }
    } }, "Update from GitHub");
    box.append(h("div", { class: "panel" }, h("h2", {}, "GitHub"), h("p", { class: "muted" }, `Set up from ${git.repo}${git.branch ? ` (${git.branch})` : ""}. Update pulls the latest code${git.kind === "static" ? "." : ", reinstalls dependencies and restarts it."}`), btn, out));
  }
  if (server.source !== "ui") {
    box.append(h("div", { class: "panel" }, h("p", {}, "This server is defined in servers.json on the machine, so it's edited there. Servers you add from the web UI can be edited here.")));
    return;
  }
  if (!server.canEditConfig) {
    box.append(h("div", { class: "panel" }, h("p", {}, "Editing servers is turned off (safe mode).")));
    return;
  }
  const cfg = await api(`/servers/${encodeURIComponent(server.id)}/config`);
  box.append(
    h(
      "div",
      { class: "panel" },
      serverForm({
        existing: cfg,
        onSubmit: async (body) => {
          await api(`/servers/${encodeURIComponent(server.id)}`, { method: "PUT", body });
          toast("Saved");
          reload();
        },
      })
    ),
    h(
      "div",
      { class: "panel danger-zone" },
      h("h2", {}, "Remove from Console"),
      h("p", { class: "muted" }, "This only forgets the server here (and its schedules and history). The real server, its files and its backups are not touched."),
      h("button", { class: "danger", onclick: async () => {
        if (!confirm(`Remove ${server.name} from Console?`)) return;
        try {
          await api(`/servers/${encodeURIComponent(server.id)}`, { method: "DELETE" });
          toast("Removed");
          location.hash = "#/";
        } catch (err) {
          toast(err.message, true);
        }
      } }, "Remove server")
    )
  );
}
