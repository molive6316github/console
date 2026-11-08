import { h, api, toast, field } from "../ui.js";

export async function linuxView(box) {
  const body = h("div", {});
  box.append(
    h("div", { class: "titlebar" }, h("h1", {}, "Linux users"), h("span", { class: "muted" }, "Accounts on this machine (not Console logins; those are under Users)")),
    h("p", { class: "notice" }, "These are real accounts on the server. Giving someone sudo gives them full control of this machine. Removing the wrong account can lock people out. Console refuses to touch its own account."),
    body
  );

  async function draw() {
    let data;
    try {
      data = await api("/linux/users");
    } catch (err) {
      return void body.replaceChildren(h("div", { class: "error" }, err.message));
    }
    body.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("table", {}, h("thead", {}, h("tr", {}, ...["User", "Sudo", "Home", ""].map((x) => h("th", {}, x)))), h("tbody", {}, ...data.users.map((u) => row(u, data))))
      ),
      createPanel(data)
    );
  }

  function row(u, data) {
    const keysBox = h("div", { hidden: true });
    const actions = h(
      "div",
      { class: "row" },
      h("button", { onclick: async () => {
        keysBox.hidden = !keysBox.hidden;
        if (!keysBox.hidden) await drawKeys(u, keysBox);
      } }, "SSH keys"),
      data.sudoGroup && h("button", { disabled: u.self && u.sudo, title: u.self ? "This is the account Console runs as" : "", onclick: async () => {
        const on = !u.sudo;
        if (!confirm(on ? `Give ${u.name} sudo? They will be able to do anything on this server.` : `Remove sudo from ${u.name}?`)) return;
        try { await api(`/linux/users/${u.name}/sudo`, { method: "POST", body: { on } }); toast("Done"); draw(); } catch (e) { toast(e.message, true); }
      } }, u.sudo ? "Remove sudo" : "Make admin (sudo)"),
      !u.self && h("button", { class: "danger", onclick: () => removeDialog(u) }, "Delete…")
    );
    return h("tr", {}, h("td", {}, u.name, u.self && h("span", { class: "tag" }, "Console runs as this")), h("td", {}, u.sudo ? "yes" : "no"), h("td", {}, h("code", {}, u.home)), h("td", {}, actions, keysBox));
  }

  async function drawKeys(u, el) {
    const input = h("textarea", { rows: "2", placeholder: "ssh-ed25519 AAAA… you@laptop", spellcheck: "false" });
    try {
      const keys = await api(`/linux/users/${u.name}/keys`);
      el.replaceChildren(
        keys.length === 0 ? h("p", { class: "muted" }, "No keys yet.") : h("table", {}, h("tbody", {}, ...keys.map((k) => h("tr", {}, h("td", {}, k.type), h("td", {}, k.comment || ""), h("td", {}, h("code", {}, k.fingerprint ?? "")), h("td", {}, k.fingerprint && h("button", { class: "danger", onclick: async () => {
          if (!confirm("Remove this key? Whoever uses it won't be able to log in as " + u.name + ".")) return;
          try { await api(`/linux/users/${u.name}/keys/remove`, { method: "POST", body: { fingerprint: k.fingerprint } }); drawKeys(u, el); } catch (e) { toast(e.message, true); }
        } }, "Remove")))))),
        field("Add a public key", input, "Paste the contents of the .pub file (not the private key)."),
        h("button", { class: "primary", onclick: async () => {
          try { await api(`/linux/users/${u.name}/keys`, { method: "POST", body: { key: input.value } }); toast("Key added"); drawKeys(u, el); } catch (e) { toast(e.message, true); }
        } }, "Add key")
      );
    } catch (err) {
      el.replaceChildren(h("div", { class: "error" }, err.message));
    }
  }

  function removeDialog(u) {
    const confirmBox = h("input", { placeholder: `Type ${u.name}`, autocomplete: "off" });
    const home = h("input", { type: "checkbox" });
    const msg = h("div", { class: "error" });
    const dlg = h(
      "div",
      { class: "panel danger-zone" },
      h("h2", {}, `Delete ${u.name}?`),
      h("p", { class: "muted" }, "This removes the login. If you also delete the home folder, their files are gone for good."),
      h("label", { class: "check" }, home, `Also delete ${u.home}`),
      field("Type the name to confirm", confirmBox),
      msg,
      h("div", { class: "row" },
        h("button", { class: "danger", onclick: async () => {
          try { await api(`/linux/users/${u.name}/delete`, { method: "POST", body: { confirm: confirmBox.value, deleteHome: home.checked } }); toast(`${u.name} deleted`); draw(); } catch (e) { msg.textContent = e.message; }
        } }, "Delete user"),
        h("button", { onclick: () => dlg.remove() }, "Cancel"))
    );
    body.prepend(dlg);
    confirmBox.focus();
  }

  function createPanel(data) {
    const name = h("input", { placeholder: "alex", autocomplete: "off", spellcheck: "false" });
    const key = h("textarea", { rows: "2", placeholder: "ssh-ed25519 AAAA… (optional, can add later)", spellcheck: "false" });
    const sudo = h("input", { type: "checkbox" });
    const msg = h("div", { class: "error" });
    return h(
      "div",
      { class: "panel" },
      h("h2", {}, "Add a user"),
      h("p", { class: "muted" }, "They log in with an SSH key (no password is set). Oracle Cloud servers don't allow password logins anyway."),
      h(
        "form",
        { class: "stack wide", onsubmit: async (e) => {
          e.preventDefault();
          msg.textContent = "";
          try {
            await api("/linux/users", { method: "POST", body: { name: name.value.trim(), sudo: sudo.checked, key: key.value.trim() } });
            toast(`${name.value.trim()} created`);
            draw();
          } catch (err) { msg.textContent = err.message; }
        } },
        field("User name", name, "Lowercase letters, numbers, - and _"),
        field("Public SSH key", key),
        data.sudoGroup && h("label", { class: "check" }, sudo, "Can use sudo (full control of this server)"),
        msg,
        h("button", { class: "primary", type: "submit" }, "Create user")
      )
    );
  }

  await draw();
}
