import { h, api, toast, field } from "../ui.js";

export function accountView(box, { me }) {
  const cur = h("input", { type: "password", autocomplete: "current-password", required: true });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const again = h("input", { type: "password", autocomplete: "new-password", minlength: "10", required: true });
  const msg = h("div", { class: "error" });
  const form = h(
    "form",
    {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = "";
        if (next.value !== again.value) return void (msg.textContent = "New passwords don't match");
        try {
          await api("/password", { method: "POST", body: { current: cur.value, next: next.value } });
          form.reset();
          toast("Password changed. Your other sessions were signed out.");
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    field("Current password", cur),
    field("New password (10+ characters)", next),
    field("Repeat new password", again),
    msg,
    h("button", { class: "primary", type: "submit" }, "Change password")
  );
  box.append(h("div", { class: "titlebar" }, h("h1", {}, "Account")), h("p", { class: "muted" }, `Signed in as ${me.username} (${me.role}). Console v${me.version}.`), h("div", { class: "panel" }, h("h2", {}, "Change password"), form));
}
