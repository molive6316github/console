import { h, api, toast, bytes, when, duration, lifecycle } from "../ui.js";
import { setPrefill, takePrefill, serverForm, slug } from "./serverForm.js";

const kb = (n) => (n == null ? "?" : bytes(n * 1024));
const table = (head, rows, empty = "Nothing found.") =>
  rows.length
    ? h("table", {}, h("thead", {}, h("tr", {}, head.map((t) => h("th", {}, t)))), h("tbody", {}, rows))
    : h("div", { class: "empty small" }, empty);
const section = (title, note, ...body) => h("div", { class: "panel" }, h("div", { class: "row spread" }, h("h2", {}, title)), note && h("p", { class: "muted" }, note), ...body);

// "Add to Console" hands the details to the add-server form.
function addTo(prefill) {
  setPrefill(prefill);
  location.hash = "#/new";
}

export function newServerView(box) {
  const prefill = takePrefill();
  box.append(
    h("p", { class: "crumb" }, h("a", { href: "#/discover" }, "← Discover")),
    h("div", { class: "titlebar" }, h("h1", {}, "Add a server")),
    prefill?.note && h("p", { class: "muted" }, prefill.note),
    h(
      "div",
      { class: "panel" },
      serverForm({
        prefill,
        onCancel: () => history.back(),
        onSubmit: async (body) => {
          await api("/servers", { method: "POST", body });
          toast(`Added ${body.name}`);
          location.hash = `#/s/${encodeURIComponent(body.id)}`;
        },
      })
    )
  );
}

export function discoverView(box, { me }) {
  const life = lifecycle();
  const canDelete = !me.safeMode;
  const dialog = h("div", {});
  const sections = h("div", {});
  let showVendor = false;
  const slots = {};
  const slot = (k) => (slots[k] ??= h("div", {}));

  const loading = (k, text) => slot(k).replaceChildren(h("div", { class: "panel" }, h("p", { class: "muted" }, text)));
  const failed = (k, title, reason) => slot(k).replaceChildren(section(title, null, h("p", { class: "muted" }, reason)));

  async function guarded(fn, ok) {
    try {
      const r = await fn();
      if (ok) toast(typeof ok === "function" ? ok(r) : ok);
      return r;
    } catch (err) {
      toast(err.message, true);
      return null;
    }
  }

  // ---- tmux -------------------------------------------------------------------------
  async function loadTmux() {
    loading("tmux", "Looking for tmux sessions…");
    let r;
    try {
      r = await api("/discover/tmux");
    } catch (e) {
      return failed("tmux", "tmux sessions", e.message);
    }
    if (!r.ok) return failed("tmux", "tmux sessions", r.reason);
    const rows = r.sessions.map((s) =>
      h(
        "tr",
        {},
        h("td", {}, h("strong", {}, s.name), s.attached ? h("small", { class: "muted" }, " (someone is attached)") : ""),
        h("td", {}, s.cwd ? h("code", {}, s.cwd) : "-"),
        h("td", {}, s.command ? h("code", {}, s.command.slice(0, 80)) : "-"),
        h("td", {}, s.created ? when(s.created) : "-"),
        h(
          "td",
          { class: "right nowrap" },
          s.managedBy
            ? h("a", { href: `#/s/${encodeURIComponent(s.managedBy)}` }, "In Console")
            : [
                h("button", { class: "primary", onclick: () => addTo({ id: slug(s.name), name: s.name, type: "tmux", target: { session: s.name, cwd: s.cwd ?? undefined, startCommand: s.command ?? "" }, note: `Found running as tmux session "${s.name}". Console can't know how it was started, so check the start command: it's what Start and Restart will run.` }) }, "Add to Console"),
                " ",
                canDelete && h("button", { class: "danger", onclick: () => killTmux(s) }, "Kill")
              ]
        )
      )
    );
    slot("tmux").replaceChildren(
      section(
        "tmux sessions",
        `Sessions belonging to the "${r.runningAs}" user, which is who Console runs as.`,
        table(["Session", "Folder", "Started with", "Since", ""], rows, "No tmux sessions are running as this user."),
        ...r.others.map((o) =>
          h("p", { class: "notice" }, o.readable ? `User "${o.user}" also has tmux sessions (${o.sessions.join(", ")}), but they're theirs: Console can see them, not control them.` : `User "${o.user}" has a tmux server Console can't look into. Anything running in it is invisible here. To manage those servers, stop them and start them from Console (Add server), so they run as "${r.runningAs}".`)
        )
      )
    );
  }

  async function killTmux(s) {
    if (!confirm(`Kill tmux session "${s.name}"?\n\nEverything running in it stops immediately, with no chance to save. For a game server, use its Stop button instead so it shuts down gracefully.`)) return;
    if (await guarded(() => api("/discover/tmux/kill", { method: "POST", body: { session: s.name } }), "Killed")) loadTmux();
  }

  // ---- docker -----------------------------------------------------------------------
  async function loadDocker() {
    loading("docker", "Looking at Docker…");
    let r;
    try {
      r = await api("/discover/docker");
    } catch (e) {
      return failed("docker", "Docker", e.message);
    }
    if (!r.ok) return failed("docker", "Docker", r.reason);
    const stopped = r.containers.filter((c) => c.state !== "running").length;
    const dangling = r.images.filter((i) => i.dangling).length;
    const cRows = r.containers.map((c) =>
      h(
        "tr",
        {},
        h("td", {}, h("strong", {}, c.name)),
        h("td", {}, c.image),
        h("td", {}, c.status),
        h(
          "td",
          { class: "right nowrap" },
          c.managedBy
            ? h("a", { href: `#/s/${encodeURIComponent(c.managedBy)}` }, "In Console")
            : [
                h("button", { class: "primary", onclick: () => addTo({ id: slug(c.name), name: c.name, type: "docker", target: { container: c.name } }) }, "Add to Console"),
                " ",
                canDelete && h("button", { class: "danger", onclick: () => removeContainer(c) }, c.state === "running" ? "Force remove" : "Remove")
              ]
        )
      )
    );
    const iRows = r.images.map((i) =>
      h(
        "tr",
        { class: i.inUse ? "" : "unused" },
        h("td", {}, i.ref),
        h("td", {}, i.size),
        h("td", {}, i.created),
        h("td", {}, i.inUse ? "used by a container" : i.dangling ? "untagged, unused" : "unused"),
        h("td", { class: "right" }, canDelete && !i.inUse && h("button", { class: "danger", onclick: () => removeImage(i) }, "Remove"))
      )
    );
    slot("docker").replaceChildren(
      section(
        "Docker",
        "Volumes (where container data lives) are never touched from here.",
        h("h3", {}, "Containers"),
        table(["Name", "Image", "Status", ""], cRows, "No containers."),
        h("h3", {}, "Images"),
        table(["Image", "Size", "Created", "", ""], iRows, "No images."),
        r.df.length ? h("p", { class: "muted" }, "Disk use: " + r.df.map((d) => `${d.type} ${d.size} (${d.reclaimable} reclaimable)`).join(" · ")) : "",
        canDelete &&
          h(
            "div",
            { class: "row" },
            h("button", { disabled: !stopped, onclick: () => prune("containers", `Remove all ${stopped} stopped container(s)?`) }, `Remove stopped containers (${stopped})`),
            h("button", { disabled: !dangling, onclick: () => prune("images", `Remove ${dangling} untagged, unused image(s)?`) }, `Remove untagged images (${dangling})`)
          )
      )
    );
  }

  async function removeContainer(c) {
    const running = c.state === "running";
    if (!confirm(running ? `"${c.name}" is RUNNING. Force-remove it? It's stopped and deleted immediately; its data volumes are kept.` : `Remove container "${c.name}"? Its data volumes are kept.`)) return;
    if (await guarded(() => api("/discover/docker/remove", { method: "POST", body: { kind: "container", id: c.name, force: running } }), "Removed")) loadDocker();
  }
  async function removeImage(i) {
    if (!confirm(`Remove image ${i.ref} (${i.size})? It can be pulled again later.`)) return;
    if (await guarded(() => api("/discover/docker/remove", { method: "POST", body: { kind: "image", id: i.dangling ? i.id : i.ref } }), "Removed")) loadDocker();
  }
  async function prune(what, question) {
    if (!confirm(question)) return;
    if (await guarded(() => api("/discover/docker/prune", { method: "POST", body: { what } }), (r) => `Freed ${r.reclaimed}`)) loadDocker();
  }

  // ---- systemd ----------------------------------------------------------------------
  async function loadSystemd() {
    loading("systemd", "Looking at services…");
    let r;
    try {
      r = await api("/discover/systemd");
    } catch (e) {
      return failed("systemd", "systemd services", e.message);
    }
    if (!r.ok) return failed("systemd", "systemd services", r.reason);
    const units = r.units.filter((u) => showVendor || !u.vendor);
    const rows = units.map((u) =>
      h(
        "tr",
        {},
        h("td", {}, h("strong", {}, u.unit), u.vendor ? h("small", { class: "muted" }, " system") : ""),
        h("td", {}, u.description),
        h("td", { class: u.active === "active" ? "ok-1" : u.active === "failed" ? "ok-0" : "" }, `${u.active} (${u.sub})`),
        h("td", { class: "right nowrap" }, u.self ? h("small", { class: "muted" }, "this is Console") : u.managedBy ? h("a", { href: `#/s/${encodeURIComponent(u.managedBy)}` }, "In Console") : h("button", { class: "primary", onclick: () => addTo({ id: slug(u.unit.replace(/\.service$/, "")), name: u.description || u.unit, type: "systemd", target: { host: "local", unit: u.unit, sudo: true }, note: "Controlling a system service as the console user needs permission. If Start/Stop fail, the error tells you the exact sudoers line to add." }) }, "Add to Console"))
      )
    );
    slot("systemd").replaceChildren(
      section(
        "systemd services",
        "Services you installed yourself, plus anything running if you show system ones.",
        table(["Service", "What it is", "State", ""], rows, "None found."),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: showVendor, onchange: (e) => ((showVendor = e.target.checked), loadSystemd()) }), "Show system services too")
      )
    );
  }

  // ---- processes --------------------------------------------------------------------
  async function loadProcesses() {
    loading("processes", "Looking at running processes…");
    let r;
    try {
      r = await api("/discover/processes");
    } catch (e) {
      return failed("processes", "Running processes", e.message);
    }
    if (!r.ok) return failed("processes", "Running processes", r.reason);
    slot("processes").replaceChildren(
      section(
        "Biggest running processes",
        "Everything using real memory, whoever started it. Read-only: this is for spotting things Console doesn't know about (a Java server started by hand, a forgotten bot).",
        table(["PID", "User", "Memory", "Running for", "Command"], r.processes.map((p) => h("tr", {}, h("td", {}, p.pid), h("td", {}, p.user), h("td", {}, kb(p.rssKB)), h("td", {}, duration(p.ageSec)), h("td", {}, h("code", {}, p.command)))))
      )
    );
  }

  // ---- folders ----------------------------------------------------------------------
  async function loadFolders() {
    loading("folders", "Measuring folders… (this can take a few seconds)");
    let r;
    try {
      r = await api("/discover/folders");
    } catch (e) {
      return failed("folders", "Folders", e.message);
    }
    const rows = r.folders.map((f) =>
      h(
        "tr",
        {},
        h("td", {}, h("strong", {}, f.name), h("br"), h("small", { class: "muted" }, f.path)),
        h("td", {}, f.sizeKB == null ? "?" : kb(f.sizeKB), f.partial ? h("small", { class: "muted" }, " (partly unreadable)") : ""),
        h("td", {}, f.tags.map((t) => h("span", { class: "tag" }, t))),
        h("td", {}, f.protected ? h("small", { class: "muted" }, f.protected) : when(f.mtime)),
        h(
          "td",
          { class: "right nowrap" },
          !f.protected && f.tags.some((t) => t === "minecraft" || t === "java") && h("button", { onclick: () => addTo({ id: slug(f.name), name: f.name, type: "tmux", target: { session: slug(f.name), cwd: f.path, startCommand: "" }, note: `Folder ${f.path} looks like a game server. Enter the command that starts it (for example: java -Xmx4G -jar server.jar nogui).` }) }, "Set up as server"),
          " ",
          canDelete && !f.protected && h("button", { class: "danger", onclick: () => deleteFolder(f) }, "Delete…")
        )
      )
    );
    const disk = r.disk ? `Disk: ${bytes(r.disk.used)} used of ${bytes(r.disk.total)}. ` : "";
    slot("folders").replaceChildren(
      section(
        "Folders",
        `${disk}Folders directly inside: ${r.roots.join(", ")}. Biggest first. Console never offers to delete itself, its database, or a folder a Console server uses.`,
        table(["Folder", "Size", "Looks like", "Modified / status", ""], rows, "No folders found in the scanned locations.")
      )
    );
  }

  function deleteFolder(f) {
    const input = h("input", { placeholder: f.name, autocomplete: "off", spellcheck: "false" });
    const archive = h("input", { type: "checkbox", checked: true });
    const msg = h("div", { class: "error" });
    const go = h("button", { class: "danger", disabled: true }, "Delete forever");
    input.addEventListener("input", () => (go.disabled = input.value !== f.name));
    go.addEventListener("click", async () => {
      go.disabled = true;
      msg.textContent = "";
      try {
        const r = await api("/discover/folder/delete", { method: "POST", body: { path: f.path, confirm: input.value, archive: archive.checked } });
        toast(`Deleted ${f.name}${r.archived ? `. Saved copy: ${r.archived}` : ""}`);
        dialog.replaceChildren();
        loadFolders();
        loadCleanup();
      } catch (err) {
        msg.textContent = err.message;
        go.disabled = input.value !== f.name;
      }
    });
    dialog.replaceChildren(
      h(
        "div",
        { class: "panel danger-zone" },
        h("h2", {}, `Delete ${f.path}?`),
        h("p", {}, `This permanently removes the folder and everything in it (${kb(f.sizeKB)}).`),
        h("label", { class: "check" }, archive, "Save a compressed copy first (kept under Console's data folder; delete it later from \"Console's own leftovers\")"),
        h("label", { class: "field" }, h("span", {}, `Type ${f.name} to confirm`), input),
        msg,
        h("div", { class: "row" }, go, h("button", { onclick: () => dialog.replaceChildren() }, "Cancel"))
      )
    );
    dialog.scrollIntoView({ behavior: "smooth", block: "start" });
    input.focus();
  }

  // ---- Console's own leftovers --------------------------------------------------------
  async function loadCleanup() {
    let r;
    try {
      r = await api("/discover/cleanup");
    } catch (e) {
      return failed("cleanup", "Console's own leftovers", e.message);
    }
    const rows = [
      ...r.orphans.map((o) => h("tr", {}, h("td", {}, `Backups of removed server "${o.id}"`), h("td", {}, kb(o.sizeKB)), h("td", { class: "right" }, canDelete && h("button", { class: "danger", onclick: () => cleanDelete("orphan", o.id, `Delete all backups of "${o.id}"?`) }, "Delete")))),
      ...r.archives.map((a) => h("tr", {}, h("td", {}, `Saved copy of a deleted folder: ${a.name}`), h("td", {}, bytes(a.size)), h("td", { class: "right" }, canDelete && h("button", { class: "danger", onclick: () => cleanDelete("archive", a.name, `Delete the saved copy ${a.name}? Then it's gone for good.`) }, "Delete")))),
    ];
    slot("cleanup").replaceChildren(section("Console's own leftovers", "Backups of servers you removed, and the safety copies Console saved before you deleted folders.", table(["What", "Size", ""], rows, "Nothing to clean up.")));
  }
  async function cleanDelete(kind, name, q) {
    if (confirm(q) && (await guarded(() => api("/discover/cleanup/delete", { method: "POST", body: { kind, name } }), "Deleted"))) loadCleanup();
  }

  function scanAll() {
    loadTmux();
    loadDocker();
    loadSystemd();
    loadProcesses();
    loadFolders();
    loadCleanup();
  }

  sections.append(...["tmux", "docker", "systemd", "folders", "cleanup", "processes"].map(slot));
  box.append(
    h("div", { class: "titlebar" }, h("h1", {}, "Discover"), h("button", { onclick: scanAll }, "Scan again")),
    h("p", { class: "muted" }, "What's already on this machine, and what Console can and can't see. Add things to manage them, or clean up what you don't need." + (canDelete ? "" : " (Safe mode is on, so deleting is disabled.)")),
    dialog,
    sections
  );
  scanAll();
  return () => life.stop();
}
