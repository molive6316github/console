import { h, api, toast, field } from "../ui.js";
import { followJob } from "../views/create.js";
import { fixItButton } from "./autofix.js";

const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`);
const slug = (f) => f.replace(/\.zip$/i, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 48);

// Uploads need progress, and fetch can't report it for request bodies, so this one uses XHR.
function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open("POST", url);
    x.setRequestHeader("Content-Type", "application/octet-stream");
    x.setRequestHeader("X-Console-Upload", "1");
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      let d = null;
      try { d = JSON.parse(x.responseText); } catch { /* not json */ }
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d?.error ?? `Upload failed (${x.status})`));
    };
    x.onerror = () => reject(new Error("The upload was interrupted"));
    x.send(file);
  });
}

export async function mapsPage(box, { server, life }) {
  const base = `/servers/${encodeURIComponent(server.id)}/mc`;
  const listBox = h("div", {});
  const mvBox = h("div", { class: "panel" });
  const addBox = h("div", { class: "panel" });
  const lobbyBox = h("div", { class: "panel" });
  let data = null;

  box.append(
    h("div", { class: "panel" }, h("h2", {}, "Worlds & maps"), h("p", { class: "muted" }, "Upload a map, download one, grab one from a link, and run several worlds on one server. Nothing here deletes a world: removing one moves it into old-worlds/ so you can get it back.")),
    listBox, addBox, mvBox, lobbyBox
  );

  async function draw() {
    data = await api(`${base}/worlds`);
    drawList(); drawAdd(); drawMv(); drawLobby();
  }
  const stopped = () => !data.running;
  const confirmId = (what) => prompt(`${what}\n\nType the server ID (${server.id}) to confirm:`)?.trim();

  function drawList() {
    const rows = data.worlds.map((w) => {
      const act = async (path, body, msg) => {
        try { await api(`${base}/worlds/${path}`, { method: "POST", body }); toast(msg); await draw(); } catch (e) { toast(e.message, true); }
      };
      return h("tr", {},
        h("td", {}, h("b", {}, w.name), w.main ? h("span", { class: "pill good" }, "main") : null, w.dims.length ? h("div", { class: "muted small" }, `+ ${w.dims.map((d) => d.replace(w.name + "_", "")).join(", ")}`) : null),
        h("td", {}, mb(w.size)),
        h("td", { class: "right" }, h("div", { class: "row end" },
          h("a", { class: "button", href: `/api/servers/${encodeURIComponent(server.id)}/mc/worlds/${encodeURIComponent(w.name)}/download`, download: `${w.name}.zip` }, "Download"),
          !w.main && data.multiverse.installed && data.running ? h("button", { onclick: () => act("activate", { name: w.name }, "Sent to the server. Check the console") }, "Load now") : null,
          !w.main ? h("button", { disabled: !stopped(), title: stopped() ? "Players will start here next time the server starts" : "Stop the server first", onclick: () => { const c = confirmId(`Make ${w.name} the main world?`); if (c) act("set-main", { name: w.name, confirm: c }, "Done. It takes effect on next start"); } }, "Make main") : null,
          !w.main ? h("button", { class: "danger", disabled: !stopped(), title: stopped() ? "" : "Stop the server first", onclick: () => { const c = confirmId(`Remove ${w.name}? It's moved to old-worlds/, not deleted.`); if (c) act("archive", { name: w.name, confirm: c }, "Moved to old-worlds/"); } }, "Remove") : null)));
    });
    listBox.replaceChildren(h("div", { class: "panel" }, h("h2", {}, "Your worlds"),
      rows.length ? h("table", {}, h("thead", {}, h("tr", {}, ["World", "Size", ""].map((t) => h("th", {}, t)))), h("tbody", {}, rows)) : h("p", { class: "muted" }, "No worlds yet. Start the server once or upload one below."),
      data.running ? h("p", { class: "muted small" }, "Downloads are safe while the server runs: saving pauses for a moment so the zip isn't half-written.") : null));
  }

  function drawAdd() {
    const file = h("input", { type: "file", accept: ".zip,application/zip" });
    const name = h("input", { placeholder: "Name for the world", autocomplete: "off", spellcheck: "false", maxlength: "48" });
    file.addEventListener("change", () => { if (file.files[0] && !name.value) name.value = slug(file.files[0].name); });
    const bar = h("progress", { max: "1", value: "0", hidden: true });
    const go = h("button", { class: "primary" }, "Upload and add");
    go.addEventListener("click", async () => {
      if (!file.files[0]) return toast("Pick a .zip first", true);
      if (!name.value.trim()) return toast("Give the world a name", true);
      go.disabled = true; bar.hidden = false;
      try {
        const r = await upload(`/api/servers/${encodeURIComponent(server.id)}/mc/worlds/upload?name=${encodeURIComponent(name.value.trim())}`, file.files[0], (p) => { bar.value = p; });
        toast(`Added ${r.name}`);
        file.value = ""; name.value = "";
        await draw();
      } catch (e) { toast(e.message, true); } finally { go.disabled = false; bar.hidden = true; }
    });
    const url = h("input", { type: "url", placeholder: "https://… link to a .zip", autocomplete: "off", spellcheck: "false" });
    const uname = h("input", { placeholder: "Name for the world", autocomplete: "off", spellcheck: "false", maxlength: "48" });
    const job = h("div", {});
    const fetchBtn = h("button", {}, "Download from link");
    fetchBtn.addEventListener("click", async () => {
      if (!url.value.trim() || !uname.value.trim()) return toast("Need a link and a name", true);
      fetchBtn.disabled = true;
      try {
        const r = await api(`${base}/worlds/import-url`, { method: "POST", body: { url: url.value.trim(), name: uname.value.trim() } });
        job.replaceChildren();
        followJob(job, r.jobId, { life, onDone: () => { fetchBtn.disabled = false; draw().catch(() => {}); } });
      } catch (e) { fetchBtn.disabled = false; toast(e.message, true); }
    });
    addBox.replaceChildren(h("h2", {}, "Add a world"),
      h("div", { class: "stack wide" },
        field("Upload a zip from your computer", file, "Any map zip works: a folder with level.dat inside (a wrapper folder is fine)."), field("Name", name), h("div", { class: "row" }, go, bar)),
      h("hr", {}),
      h("div", { class: "stack wide" },
        field("…or paste a link", url, "Public links only. Links to private networks are refused."), field("Name", uname), h("div", { class: "row" }, fetchBtn), job));
  }

  function drawMv() {
    const mv = data.multiverse;
    const inst = h("button", { class: "primary" }, "Install Multiverse");
    inst.addEventListener("click", async () => {
      inst.disabled = true; inst.textContent = "Installing…";
      try { await api(`${base}/catalog/install`, { method: "POST", body: { slugs: ["multiverse-core"] } }); toast("Installed. Restart the server to turn it on"); await draw(); } catch (e) { toast(e.message, true); inst.disabled = false; inst.textContent = "Install Multiverse"; }
    });
    mvBox.replaceChildren(h("h2", {}, "Several worlds on one server"),
      mv.installed
        ? h("p", {}, h("span", { class: "good" }, `Multiverse ${mv.version ?? ""} is installed.`), " Add worlds above, press Load now on a running server, and players hop with ", h("code", {}, "/mv tp <world>"), ".")
        : h("div", { class: "stack wide" }, h("p", { class: "muted" }, "Multiverse is the plugin that lets one server run many worlds. Needs a Paper-type server and a restart after install."), h("div", { class: "row" }, inst)));
  }

  function drawLobby() {
    const mv = data.multiverse;
    const name = h("input", { value: "lobby", autocomplete: "off", spellcheck: "false", maxlength: "48" });
    const out = h("div", { class: "stack wide" });
    const show = h("button", {}, "Show the plan");
    show.addEventListener("click", async () => {
      try {
        const { steps } = await api(`${base}/lobby?name=${encodeURIComponent(name.value.trim())}`);
        const rows = steps.map((s) => ({ s, on: h("input", { type: "checkbox", checked: true }), cmd: h("input", { value: s.cmd, spellcheck: "false", autocomplete: "off", class: "mono" }) }));
        const res = h("div", { class: "stack wide" });
        const run = h("button", { class: "primary", disabled: !data.running, title: data.running ? "" : "Start the server first" }, "Run these in the game");
        run.addEventListener("click", async () => {
          const commands = rows.filter((r) => r.on.checked).map((r) => r.cmd.value.trim());
          run.disabled = true;
          try {
            const r = await api(`${base}/lobby/run`, { method: "POST", body: { commands } });
            const bad = r.results.filter((x) => !x.ok);
            res.replaceChildren(...r.results.map((x) => h("div", {}, h("div", { class: x.ok ? "good small" : "bad small" }, `${x.ok ? "✓" : "✗"} ${x.cmd}`), x.output ? h("pre", { class: "snippet" }, x.output) : null)),
              bad.length ? fixItButton("minecraft", server.id, `Lobby setup commands failed on Multiverse ${mv.version ?? "?"}: ${bad.map((b) => `${b.cmd} -> ${b.output.slice(0, 200)}`).join(" | ")}`, () => {}) : h("p", { class: "good" }, "All sent. Stand where you want players to spawn and run /mv setspawn in the game."));
          } catch (e) { toast(e.message, true); } finally { run.disabled = !data.running; }
        });
        out.replaceChildren(
          h("p", { class: "muted small" }, "Edit or untick anything. Command names differ a little between Multiverse versions, so the results below show what the server actually said."),
          ...rows.map((r) => h("div", { class: "row tight" }, r.on, h("div", { class: "grow" }, h("div", { class: "small muted" }, r.s.label), r.cmd))),
          h("div", { class: "row" }, run), res);
      } catch (e) { toast(e.message, true); }
    });
    lobbyBox.replaceChildren(h("h2", {}, "Lobby builder"),
      mv.installed ? h("div", { class: "stack wide" }, h("p", { class: "muted" }, "Sets up a safe hub world: peaceful, no PvP, no monsters, adventure mode, always day. Use an existing world's name (like one you just uploaded) or a new name to create a flat one."), field("Lobby world name", name), h("div", { class: "row" }, show), out)
        : h("p", { class: "muted" }, "Install Multiverse above first."));
  }

  await draw();
  return box;
}
