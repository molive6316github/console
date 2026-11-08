import { h, api, toast, field } from "../ui.js";

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
    h("div", { class: "panel" }, h("h2", {}, "Safe mode"), h("p", { class: "muted" }, me.safeMode ? "Safe mode is ON. Adding/editing servers, the file editor and sending commands are disabled." : "Safe mode is off. To disable adding/editing servers, the file editor and commands (for example on a shared install), set CONSOLE_SAFE_MODE=1 in /etc/console.env and restart Console."))
  );
}
