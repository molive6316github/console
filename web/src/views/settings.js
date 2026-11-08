import { h, api, toast, field } from "../ui.js";
import { LEVELS, getLevel, setLevel } from "../level.js";

export async function settingsView(box, { me }) {
  let s;
  try {
    s = await api("/settings");
  } catch (err) {
    return void box.append(h("div", { class: "error" }, err.message));
  }
  const hook = h("input", { placeholder: s.alertsConfigured ? `Currently: ${s.alertWebhook} (type a new one to replace)` : "https://discord.com/api/webhooks/…", autocomplete: "off", spellcheck: "false" });
  const tz = h("input", { value: s.timezone, placeholder: "America/New_York", spellcheck: "false" });
  const keep = h("input", { type: "number", min: "1", max: "50", value: String(s.backupKeep) });
  const msg = h("div", { class: "error" });
  const ghToken = h("input", { type: "password", autocomplete: "off", spellcheck: "false", placeholder: s.githubToken ? `Saved (${s.githubToken}). Paste a new one to replace.` : "ghp_… or github_pat_…" });

  function toggle(label, help, on, key) {
    const box = h("input", { type: "checkbox", checked: on, onchange: async (e) => {
      const want = e.target.checked;
      if (want && !confirm(`Turn on: ${label}?\n\n${help}`)) return void (e.target.checked = false);
      if (!(await save({ [key]: want }, want ? `${label} is on` : `${label} is off`))) e.target.checked = !want;
      else window.dispatchEvent(new Event("console:features")); // refetch who-can-see-what and redraw the menu
    } });
    return h("label", { class: "check" }, box, h("span", {}, h("b", {}, label), ` — ${help}`));
  }

  async function save(body, ok) {
    msg.textContent = "";
    try {
      s = await api("/settings", { method: "PUT", body });
      toast(ok);
      hook.value = "";
      hook.placeholder = s.alertsConfigured ? `Currently: ${s.alertWebhook} (type a new one to replace)` : "https://discord.com/api/webhooks/…";
      return true;
    } catch (err) {
      msg.textContent = err.message;
      return false;
    }
  }

  box.append(
    h("div", { class: "titlebar" }, h("h1", {}, "Settings")),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Down alerts"),
      h("p", { class: "muted" }, "Console checks every server once a minute. If one that should be running is down for 2 checks in a row, it posts to your webhook, and again when it's back. Stopping something from Console never triggers an alert."),
      h(
        "form",
        { class: "stack wide", onsubmit: async (e) => (e.preventDefault(), hook.value.trim() && (await save({ alertWebhook: hook.value.trim() }, "Webhook saved"))) },
        field("Discord or Slack webhook URL", hook, "Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL. It's stored on this machine and never shown in full again."),
        h(
          "div",
          { class: "row" },
          h("button", { class: "primary", type: "submit" }, "Save webhook"),
          h("button", { type: "button", onclick: async () => api("/alerts/test", { method: "POST", body: {} }).then(() => toast("Sent. Check your channel."), (e) => toast(e.message, true)) }, "Send test alert"),
          s.alertsConfigured && h("button", { type: "button", class: "danger", onclick: () => confirm("Turn alerts off?") && save({ alertWebhook: "" }, "Alerts off").then(() => location.reload()) }, "Turn off")
        )
      )
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Schedules and backups"),
      h(
        "form",
        { class: "stack wide", onsubmit: async (e) => (e.preventDefault(), await save({ timezone: tz.value.trim(), backupKeep: Number(keep.value) }, "Saved")) },
        field("Time zone", tz, "Schedules run on this clock. Use a name like America/New_York (Greenville is America/New_York). The server itself is probably on UTC."),
        field("Backups to keep per server", keep, "Older ones are deleted automatically after each backup."),
        msg,
        h("button", { class: "primary", type: "submit" }, "Save")
      )
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "GitHub access"),
      h("p", { class: "muted" }, "Only needed for private repositories. Create a fine-grained token on GitHub with read-only \"Contents\" access to just the repos you want. It is stored on this machine, never shown again, and never printed in logs."),
      h(
        "form",
        { class: "stack wide", onsubmit: async (e) => (e.preventDefault(), ghToken.value.trim() && (await save({ githubToken: ghToken.value.trim() }, "Token saved"), (ghToken.value = ""))) },
        field("GitHub token", ghToken),
        h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, "Save token"), s.githubToken && h("button", { type: "button", class: "danger", onclick: () => confirm("Forget the GitHub token?") && save({ githubToken: "" }, "Token removed").then(() => location.reload()) }, "Remove"))
      )
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "How much to show"),
      h("p", { class: "muted" }, "This only changes what you see in this browser. It never changes what anyone is allowed to do."),
      h("div", { class: "stack wide" }, ...LEVELS.map((l) => h("label", { class: "check" }, h("input", { type: "radio", name: "level", checked: getLevel() === l.id, onchange: () => setLevel(l.id) }), h("span", {}, h("b", {}, l.label), ` — ${l.blurb}`))))
    ),
    h(
      "div",
      { class: "panel warn" },
      h("h2", {}, "Advanced tools (off by default)"),
      h("p", { class: "muted" }, "Powerful, and risky if an admin account is ever stolen. Both are admin-only, are disabled by safe mode, and are recorded in the Audit log. Turn on only what you use."),
      me.safeMode
        ? h("p", { class: "muted" }, "Safe mode is on, so these can't be turned on.")
        : h(
            "div",
            { class: "stack wide" },
            toggle("Web terminal", "A real shell in your browser, running as the same Linux user as Console. Opens in its own tab (Advanced level: nav > Terminal). Sessions are logged (who, when, how long); what you type isn't.", s.terminalEnabled, "terminalEnabled"),
            toggle("Manage Linux users", "Create and delete accounts on this machine, add SSH keys, grant sudo. Needs passwordless sudo for Console's user (opc has it on Oracle).", s.linuxUsersEnabled, "linuxUsersEnabled")
          )
    ),
    h(
      "div",
      { class: "panel" },
      h("h2", {}, "Restart Console"),
      h("p", { class: "muted" }, "Needed after changing the Linux user's groups (for example to use Docker). Servers you started keep running."),
      h("button", { onclick: async () => {
        if (!confirm("Restart Console now?")) return;
        try {
          const r = await api("/restart", { method: "POST", body: {} });
          toast(r.restarting ? "Restarting… the page will reconnect" : "Console isn't running under systemd, so restart it yourself");
          if (r.restarting) setTimeout(() => location.reload(), 4000);
        } catch (err) { toast(err.message, true); }
      } }, "Restart Console")
    ),
    h("div", { class: "panel" }, h("h2", {}, "Safe mode"), h("p", { class: "muted" }, me.safeMode ? "Safe mode is ON. Adding/editing servers, the file editor and sending commands are disabled." : "Safe mode is off. To disable adding/editing servers, the file editor and commands (for example on a shared install), set CONSOLE_SAFE_MODE=1 in /etc/console.env and restart Console."))
  );
}
