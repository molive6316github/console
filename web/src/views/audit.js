import { h, api, toast, sqlTime } from "../ui.js";

export function auditView(box) {
  const filter = h("select", {}, h("option", { value: "" }, "All servers"));
  const table = h("div", {});
  async function load() {
    try {
      const rows = await api(`/audit?limit=300${filter.value ? `&server=${encodeURIComponent(filter.value)}` : ""}`);
      table.replaceChildren(
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["When", "User", "Server", "Action", "Result", "Detail"].map((t) => h("th", {}, t)))),
          h("tbody", {}, rows.map((r) => h("tr", {}, h("td", {}, sqlTime(r.ts)), h("td", {}, r.username), h("td", {}, r.server_id ?? "-"), h("td", {}, r.action), h("td", { class: `ok-${r.ok}` }, r.ok ? "ok" : "failed"), h("td", {}, r.detail ?? ""))))
        )
      );
    } catch (err) {
      toast(err.message, true);
    }
  }
  filter.addEventListener("change", load);
  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Audit log"), h("div", { class: "row" }, filter, h("button", { onclick: load }, "Refresh"))), table);
  api("/servers").then((s) => filter.append(...s.map((x) => h("option", { value: x.id }, x.name))), () => {});
  load();
}
