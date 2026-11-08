import { h, api, toast, field, when, lifecycle } from "../ui.js";

const PRESETS = [
  ["0 4 * * *", "Every day at 4:00"],
  ["0 */6 * * *", "Every 6 hours"],
  ["0 * * * *", "Every hour"],
  ["30 3 * * 0", "Every Sunday at 3:30"],
  ["0 5 1 * *", "1st of the month at 5:00"],
];
const describe = (cron) => PRESETS.find(([c]) => c === cron)?.[1] ?? cron;
const LABEL = { start: "Start", stop: "Stop", restart: "Restart", backup: "Back up", command: "Send command", "mc-backup": "Safe world backup", "mc-github-config": "Back up configs to GitHub", "mc-github-world": "Back up world to GitHub" };

export function schedulesView(box, { me }) {
  const life = lifecycle();
  const list = h("div", {});
  const formBox = h("div", {});
  const tz = h("p", { class: "muted" });
  let servers = [];

  async function load() {
    try {
      const [rows, settings] = await Promise.all([api("/schedules"), api("/settings")]);
      tz.textContent = `Times are in ${settings.timezone}. Change it under Settings. If Console is off at the scheduled minute, that run is skipped.`;
      list.replaceChildren(
        rows.length
          ? h(
              "table",
              {},
              h("thead", {}, h("tr", {}, ["Server", "Does", "When", "Next run", "Last result", ""].map((t) => h("th", {}, t)))),
              h(
                "tbody",
                {},
                rows.map((r) =>
                  h(
                    "tr",
                    { class: r.enabled ? "" : "off" },
                    h("td", {}, r.serverName),
                    h("td", {}, LABEL[r.action], r.arg ? h("code", {}, ` ${r.arg}`) : ""),
                    h("td", {}, describe(r.cron), r.cron !== describe(r.cron) ? "" : h("small", { class: "muted" }, ` (${r.cron})`)),
                    h("td", {}, r.enabled ? (r.next ? when(r.next) : "never") : "paused"),
                    h("td", { class: r.lastStatus === "failed" ? "ok-0" : r.lastStatus === "ok" ? "ok-1" : "" }, r.lastStatus ? `${r.lastStatus}${r.lastDetail ? `: ${r.lastDetail}` : ""}` : "-"),
                    h(
                      "td",
                      { class: "right nowrap" },
                      h("button", { onclick: () => run(r) }, "Run now"),
                      " ",
                      h("button", { onclick: () => toggle(r) }, r.enabled ? "Pause" : "Resume"),
                      " ",
                      h("button", { onclick: () => showForm(r) }, "Edit"),
                      " ",
                      h("button", { class: "danger", onclick: () => remove(r) }, "Delete")
                    )
                  )
                )
              )
            )
          : h("div", { class: "empty" }, "No schedules yet. Add one to auto-restart, back up or send a command on a timer.")
      );
    } catch (err) {
      toast(err.message, true);
    }
  }

  const run = async (r) => {
    if (!confirm(`Run "${LABEL[r.action]}" on ${r.serverName} right now?`)) return;
    try {
      await api(`/schedules/${r.id}/run`, { method: "POST", body: {} });
      toast("Done");
    } catch (err) {
      toast(err.message, true);
    }
    load();
  };
  const toggle = async (r) => (await api(`/schedules/${r.id}`, { method: "PUT", body: { enabled: !r.enabled } }).catch((e) => toast(e.message, true)), load());
  const remove = async (r) => confirm(`Delete this schedule for ${r.serverName}?`) && (await api(`/schedules/${r.id}`, { method: "DELETE" }).catch((e) => toast(e.message, true)), load());

  function actionsFor(s) {
    if (!s) return [];
    const out = [];
    if (!s.caps.readOnly) out.push("restart", "start", "stop");
    if (s.caps.files) out.push("backup");
    if (s.caps.send && !me.safeMode) out.push("command");
    if (s.mc && !me.safeMode) out.push("mc-backup", "mc-github-config", "mc-github-world");
    return out;
  }

  function showForm(existing) {
    const server = h("select", { disabled: Boolean(existing) }, servers.map((s) => h("option", { value: s.id, selected: s.id === existing?.serverId }, s.name)));
    const action = h("select", {});
    const arg = h("input", { placeholder: "say Restarting in 5 minutes!", maxlength: "1000", value: existing?.arg ?? "" });
    const argField = field("Command to type into the server", arg);
    const preset = h("select", {}, [...PRESETS, ["", "Custom…"]].map(([c, l]) => h("option", { value: c, selected: c === (existing?.cron && PRESETS.some(([p]) => p === existing.cron) ? existing.cron : existing ? "" : PRESETS[0][0]) }, l)));
    const cron = h("input", { value: existing?.cron ?? PRESETS[0][0], placeholder: "0 4 * * *", required: true, spellcheck: "false" });
    const msg = h("div", { class: "error" });

    const drawActions = () => {
      const s = servers.find((x) => x.id === server.value);
      const opts = actionsFor(s);
      action.replaceChildren(...opts.map((a) => h("option", { value: a, selected: a === existing?.action }, LABEL[a])));
      argField.hidden = action.value !== "command";
    };
    server.addEventListener("change", drawActions);
    action.addEventListener("change", () => (argField.hidden = action.value !== "command"));
    preset.addEventListener("change", () => preset.value && (cron.value = preset.value));
    cron.addEventListener("input", () => (preset.value = PRESETS.some(([c]) => c === cron.value.trim()) ? cron.value.trim() : ""));
    drawActions();

    formBox.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", {}, existing ? "Edit schedule" : "New schedule"),
        h(
          "form",
          {
            class: "stack wide",
            onsubmit: async (e) => {
              e.preventDefault();
              msg.textContent = "";
              const body = { serverId: server.value, action: action.value, cron: cron.value.trim(), arg: action.value === "command" ? arg.value : undefined };
              try {
                if (existing) await api(`/schedules/${existing.id}`, { method: "PUT", body });
                else await api("/schedules", { method: "POST", body });
                formBox.replaceChildren();
                load();
              } catch (err) {
                msg.textContent = err.message;
              }
            },
          },
          field("Server", server),
          field("Do this", action),
          argField,
          field("How often", preset),
          field("Schedule (minute hour day month weekday)", cron, "Example: 30 3 * * 0 = Sundays at 3:30. */15 * * * * = every 15 minutes."),
          msg,
          h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, existing ? "Save" : "Add schedule"), h("button", { type: "button", onclick: () => formBox.replaceChildren() }, "Cancel"))
        )
      )
    );
  }

  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Schedules"), h("button", { class: "primary", onclick: () => showForm(null) }, "New schedule")), tz, formBox, list);
  api("/servers").then((s) => (servers = s)).catch(() => {});
  load();
  life.every(load, 15_000);
  return () => life.stop();
}
