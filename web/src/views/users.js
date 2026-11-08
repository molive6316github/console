import { h, api, toast, field } from "../ui.js";

export function usersView(box, { me }) {
  const list = h("div", {});
  const formBox = h("div", {});
  let servers = [];

  async function load() {
    try {
      const rows = await api("/users");
      list.replaceChildren(
        h(
          "table",
          {},
          h("thead", {}, h("tr", {}, ["User", "Role", "Can see", ""].map((t) => h("th", {}, t)))),
          h(
            "tbody",
            {},
            rows.map((u) =>
              h(
                "tr",
                {},
                h("td", {}, u.username, u.username === me.username ? h("small", { class: "muted" }, " (you)") : ""),
                h("td", {}, u.role),
                h("td", {}, u.allServers ? "All servers" : u.servers.map((id) => servers.find((s) => s.id === id)?.name ?? id).join(", ")),
                h("td", { class: "right nowrap" }, h("button", { onclick: () => showForm(u) }, "Edit"), " ", u.username === me.username ? "" : h("button", { class: "danger", onclick: () => remove(u) }, "Delete"))
              )
            )
          )
        )
      );
    } catch (err) {
      toast(err.message, true);
    }
  }

  async function remove(u) {
    if (!confirm(`Delete ${u.username}? They're signed out immediately.`)) return;
    try {
      await api(`/users/${u.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      toast(err.message, true);
    }
  }

  function showForm(existing) {
    const username = h("input", { value: existing?.username ?? "", disabled: Boolean(existing), required: true, autocomplete: "off" });
    const password = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: !existing });
    const role = h("select", {}, ["viewer", "operator", "admin"].map((r) => h("option", { value: r, selected: r === (existing?.role ?? "operator") }, r)));
    const all = h("input", { type: "radio", name: "scope", checked: existing ? existing.allServers : true });
    const some = h("input", { type: "radio", name: "scope", checked: existing ? !existing.allServers : false });
    const boxes = servers.map((s) => ({ s, el: h("input", { type: "checkbox", checked: existing?.servers.includes(s.id) }) }));
    const picker = h("div", { class: "picker" }, boxes.map(({ s, el }) => h("label", { class: "check" }, el, s.name)));
    const msg = h("div", { class: "error" });
    const roleHelp = h("small", {});
    const sync = () => {
      const admin = role.value === "admin";
      all.disabled = some.disabled = admin;
      picker.hidden = admin || !some.checked;
      roleHelp.textContent = { viewer: "Can see status and logs.", operator: "Can also start, stop, restart and send commands.", admin: "Everything, including users, files, schedules and settings. Always sees all servers." }[role.value];
    };
    [role, all, some].forEach((el) => el.addEventListener("change", sync));
    sync();

    formBox.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", {}, existing ? `Edit ${existing.username}` : "Add a user"),
        h(
          "form",
          {
            class: "stack wide",
            onsubmit: async (e) => {
              e.preventDefault();
              msg.textContent = "";
              const body = { role: role.value, allServers: all.checked || role.value === "admin", servers: boxes.filter((b) => b.el.checked).map((b) => b.s.id) };
              if (!existing) Object.assign(body, { username: username.value.trim(), password: password.value });
              else if (password.value) body.password = password.value;
              try {
                if (existing) await api(`/users/${existing.id}`, { method: "PUT", body });
                else await api("/users", { method: "POST", body });
                toast(existing ? "Saved. They were signed out." : "User added");
                formBox.replaceChildren();
                load();
              } catch (err) {
                msg.textContent = err.message;
              }
            },
          },
          field("Username", username),
          field(existing ? "Reset password (leave empty to keep)" : "Password (10+ characters)", password),
          field("Role", role, undefined),
          roleHelp,
          h("div", { class: "stack" }, h("strong", {}, "Servers they can see"), h("label", { class: "check" }, all, "All servers"), h("label", { class: "check" }, some, "Only the ones I pick"), picker),
          msg,
          h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, existing ? "Save" : "Add user"), h("button", { type: "button", onclick: () => formBox.replaceChildren() }, "Cancel"))
        )
      )
    );
  }

  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Users"), h("button", { class: "primary", onclick: () => showForm(null) }, "Add user")), formBox, list);
  api("/servers").then((s) => ((servers = s), load()), load);
  return () => {};
}
