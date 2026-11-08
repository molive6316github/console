import { h, api, toast, dot, lifecycle } from "../ui.js";
import { serverForm } from "./serverForm.js";

export async function act(server, action, after) {
  if ((action === "stop" || action === "restart") && !confirm(`${action === "stop" ? "Stop" : "Restart"} ${server.name}?`)) return;
  server.busy = true;
  after?.();
  try {
    const r = await api(`/servers/${encodeURIComponent(server.id)}/${action}`, { method: "POST", body: {} });
    server.status = r.status;
    toast(`${server.name}: ${action} done`);
  } catch (err) {
    toast(`${server.name}: ${err.message}`, true);
  } finally {
    server.busy = false;
  }
}

export function actionButtons(s, after) {
  if (!s.canAct) return h("div", { class: "state" }, s.caps?.readOnly ? "Read-only server" : "View only");
  const off = s.busy;
  return h(
    "div",
    { class: "actions" },
    h("button", { disabled: off || s.status === "up", onclick: () => act(s, "start", after).then(after) }, "Start"),
    h("button", { class: "danger", disabled: off || s.status === "down", onclick: () => act(s, "stop", after).then(after) }, "Stop"),
    h("button", { disabled: off, onclick: () => act(s, "restart", after).then(after) }, "Restart")
  );
}

export function uptimeText(s) {
  return s.uptime24h == null ? "no history yet" : `${s.uptime24h}% up (24h)`;
}

export function serversView(box, { me }) {
  const life = lifecycle();
  let servers = [];
  const summary = h("div", { class: "summary" });
  const grid = h("div", { class: "grid" });
  const addBox = h("div", {});
  const canAdd = me.role === "admin" && !me.safeMode;

  function draw() {
    const up = servers.filter((s) => s.status === "up").length;
    summary.textContent = servers.length ? `${up} of ${servers.length} up` : "";
    if (!servers.length) {
      grid.replaceChildren(
        h("div", { class: "empty" }, me.role === "admin" ? (me.mode === "minecraft" ? h("div", {}, h("p", {}, "No Minecraft server yet."), h("a", { class: "btn primary", href: "#/create/minecraft" }, "Create your Minecraft server")) : "No servers yet. Add your first one.") : "No servers have been shared with you yet.")
      );
      return;
    }
    grid.replaceChildren(
      ...servers.map((s) =>
        h(
          "div",
          { class: "card" },
          h("div", { class: "top" }, dot(s.status), h("a", { class: "name", href: `#/s/${encodeURIComponent(s.id)}` }, s.name), h("span", { class: "type" }, s.type)),
          h("div", { class: "state" }, s.busy ? "working…" : `${s.status} · ${uptimeText(s)}`),
          s.error && h("div", { class: "err" }, s.error),
          actionButtons(s, draw)
        )
      )
    );
  }

  async function refresh() {
    try {
      const fresh = await api("/servers");
      const busy = new Set(servers.filter((s) => s.busy).map((s) => s.id));
      servers = fresh.map((s) => ({ ...s, busy: s.busy || busy.has(s.id) }));
      draw();
    } catch (err) {
      if (err.status !== 401) toast(err.message, true);
    }
  }

  function showAdd() {
    addBox.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", {}, "Add a server"),
        serverForm({
          onCancel: () => addBox.replaceChildren(),
          onSubmit: async (body) => {
            await api("/servers", { method: "POST", body });
            toast(`Added ${body.name}`);
            addBox.replaceChildren();
            location.hash = `#/s/${encodeURIComponent(body.id)}`;
          },
        })
      )
    );
  }

  box.append(
    h("div", { class: "titlebar" }, h("h1", {}, "Servers"), canAdd && h("button", { class: "primary", onclick: showAdd }, "Add server")),
    addBox,
    summary,
    grid
  );
  refresh();
  life.every(refresh, 5000);
  return () => life.stop();
}
