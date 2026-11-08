import { h, api, sleep, toast } from "../ui.js";

// After an update the server restarts. Its bootId changes when the new process is up.
async function waitForRestart(oldBoot, statusEl) {
  await sleep(2500);
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch("/api/me", { credentials: "same-origin" });
      const m = res.ok ? await res.json() : null;
      if (m?.bootId && m.bootId !== oldBoot) return void location.reload();
    } catch {
      /* server is down mid-restart, keep waiting */
    }
    await sleep(1500);
  }
  statusEl.textContent = "Taking longer than expected. On the server run: sudo journalctl -u console -n 30";
}

const fmtSteps = (steps = []) => steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.name}${s.ok || !s.output ? "" : "\n" + s.output}`).join("\n");

export function updatesView(box, { me, onInfo }) {
  const status = h("div", { class: "state" });
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
      onInfo?.(info);
      if (!info.supported) return void (status.textContent = info.error);
      if (!info.ok) return void (status.textContent = `Couldn't reach the repo: ${info.error}`);
      if (info.dirty) return void (status.textContent = `Updating is blocked because these files were changed on this server: ${(info.dirtyFiles ?? []).slice(0, 5).join(", ") || "tracked files"}.`);
      if (info.ahead > 0) return void (status.textContent = "This install has commits that aren't on the remote, so it can't fast-forward.");
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
      if (!r.updated) status.textContent = "Already up to date.";
      else if (r.restarting) {
        status.textContent = `Updated ${r.from} → ${r.to}. Restarting…`;
        return void (await waitForRestart(me.bootId, status));
      } else status.textContent = `Updated ${r.from} → ${r.to}. Restart the process to load it (it isn't running under systemd).`;
    } catch (err) {
      status.textContent = err.message;
      if (err.data?.steps) log.textContent = fmtSteps(err.data.steps);
    }
    goBtn.disabled = checkBtn.disabled = false;
  }

  // Nightly automatic updates.
  const autoBox = h("div", { class: "panel" }, h("h2", {}, "Automatic updates"));
  api("/update/auto").then((a) => {
    const on = h("input", { type: "checkbox", checked: a.enabled });
    const hour = h("select", {}, ...Array.from({ length: 24 }, (_, i) => h("option", { value: i }, `${String(i).padStart(2, "0")}:00`)));
    hour.value = a.hour;
    const msg = h("small", { class: "muted" });
    const save = async () => {
      try {
        await api("/update/auto", { method: "PUT", body: { enabled: on.checked, hour: Number(hour.value) } });
        msg.textContent = on.checked ? `On. Console will update itself around ${String(hour.value).padStart(2, "0")}:00, only when nobody is playing.` : "Off.";
      } catch (e) {
        msg.textContent = e.message;
      }
    };
    on.addEventListener("change", save);
    hour.addEventListener("change", save);
    msg.textContent = a.enabled ? `On. Console will update itself around ${String(a.hour).padStart(2, "0")}:00, only when nobody is playing.` : "Off.";
    autoBox.append(
      h("div", { class: "stack wide" }, h("label", { class: "check" }, on, "Update Console automatically every night"), h("label", { class: "field" }, h("span", {}, "Time"), hour), msg,
        h("small", { class: "muted" }, a.channel === "release" ? "It only installs versions that have been published as releases, never half-finished work. If the build fails it rolls back by itself, and you get an alert either way." : "Following the main branch directly.")));
  }).catch(() => {});
  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Updates")), h("div", { class: "panel" }, status, list, h("div", { class: "row" }, checkBtn, goBtn), log), autoBox,
    h("div", { class: "panel" }, h("h2", {}, "Restart"), h("p", { class: "muted" }, "Restarts Console only. Your Minecraft server keeps running."),
      h("button", { onclick: async () => {
        if (!confirm("Restart Console now?")) return;
        try {
          const r = await api("/restart", { method: "POST", body: {} });
          if (!r.restarting) return toast("Console wasn't started in a way that can restart itself. Stop it and start it again.", true);
          toast("Restarting…");
          await waitForRestart(me.bootId, status);
        } catch (err) { toast(err.message, true); }
      } }, "Restart Console")));
  runCheck(false);
}
