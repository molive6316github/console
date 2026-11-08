import { h, api, toast, duration } from "../ui.js";
import { followJob } from "../views/create.js";
import { hostView } from "../views/host.js";

// The machine itself: load, OS updates, restarting it, and Console's own log. All the stuff that used to need SSH.
export function machinePage(box, ctx) {
  const stop = hostView(box, ctx);
  const os = h("div", { class: "panel" }, h("h2", {}, "Operating system updates"), h("div", { class: "muted" }, "Checking…"));
  const power = h("div", { class: "panel" });
  const logBox = h("div", { class: "panel" });
  box.append(os, power, logBox);

  async function draw(fresh) {
    let s;
    try {
      s = await api(`/system${fresh ? "?force=1" : ""}`);
    } catch (e) {
      return void os.replaceChildren(h("h2", {}, "Operating system updates"), h("div", { class: "error" }, e.message));
    }
    const out = h("div", {});
    const go = h("button", { class: "primary", disabled: !s.sudo || !s.updates.length, onclick: async () => {
      if (!confirm("Install all pending updates now? Console and your Minecraft server keep running; some updates need a machine restart afterward.")) return;
      go.disabled = true;
      try {
        const r = await api("/system/upgrade", { method: "POST", body: {} });
        out.replaceChildren();
        followJob(out, r.jobId, { life: ctx.life, onDone: () => draw(true) });
      } catch (e) {
        toast(e.message, true);
        go.disabled = false;
      }
    } }, s.updates.length ? `Install ${s.updates.length} update${s.updates.length === 1 ? "" : "s"}` : "Nothing to install");
    os.replaceChildren(
      h("h2", {}, "Operating system updates"),
      !s.pm ? h("p", { class: "muted" }, "No supported package manager found on this machine.") :
      h("div", {},
        h("p", {}, s.updates.length ? `${s.updates.length} update${s.updates.length === 1 ? " is" : "s are"} waiting.` : "Everything is up to date."),
        s.updates.length ? h("div", { class: "chips" }, ...s.updates.slice(0, 12).map((n) => h("span", { class: "chip" }, n)), s.updates.length > 12 ? h("span", { class: "muted" }, `+${s.updates.length - 12} more`) : null) : null,
        !s.sudo ? h("p", { class: "notice" }, "Console can't run admin commands here (no passwordless sudo), so it can look but not install.") : null,
        s.rebootRequired ? h("p", { class: "notice" }, "A restart of the machine is needed to finish applying earlier updates.") : null,
        h("div", { class: "row" }, go, h("button", { onclick: () => draw(true) }, "Check again")), out)
    );
    const word = h("input", { placeholder: 'Type "restart"', autocomplete: "off" });
    const force = h("input", { type: "checkbox" });
    power.replaceChildren(
      h("h2", {}, "Restart the machine"),
      h("p", { class: "muted" }, `Up for ${duration(s.uptimeSec)}. This reboots the whole computer: the Minecraft server stops, then everything comes back by itself. Console will be unreachable for about a minute.`),
      h("div", { class: "stack wide" }, word, h("label", { class: "check" }, force, "Restart even if players are online"),
        h("div", { class: "row" }, h("button", { class: "danger", disabled: !s.sudo, onclick: async () => {
          try {
            await api("/system/reboot", { method: "POST", body: { confirm: word.value.trim(), force: force.checked } });
            toast("Restarting the machine… this page will come back in a minute or so.");
          } catch (e) { toast(e.message, true); }
        } }, "Restart machine")))
    );
  }

  async function pullLog() {
    try {
      const { lines } = await api("/system/logs");
      const pre = logBox.querySelector("pre");
      const stick = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      const next = h("pre", { class: "log console", tabindex: "0", "aria-label": "Console log" }, lines.join("\n") || "(nothing logged yet)");
      logBox.replaceChildren(h("h2", {}, "Console's own log"), h("p", { class: "muted" }, "What Console itself is saying: startup, errors, updates. If something is broken, look here first."), next);
      if (stick) next.scrollTop = next.scrollHeight;
    } catch { /* ignore */ }
  }

  draw(false);
  pullLog();
  ctx.life.every(pullLog, 5000);
  return stop;
}
