import { h, api, field } from "../ui.js";

// The page a new person lands on from an invite link. No account needed yet.
export async function invitePage(app, token, onDone) {
  const card = h("div", { class: "login invitecard" }, h("h1", {}, "Checking your invite…"));
  app.replaceChildren(card);
  let info;
  try {
    info = await api(`/invite/${encodeURIComponent(token)}`);
  } catch (e) {
    card.replaceChildren(h("h1", {}, "This link doesn't work"), h("p", { class: "muted" }, e.message), h("a", { href: "#/" }, "Go to sign in"));
    return;
  }
  const user = h("input", { name: "username", placeholder: "Pick a username", autocomplete: "username", required: true, maxlength: 32 });
  const pass = h("input", { name: "password", type: "password", placeholder: "Choose a password (12+ characters)", autocomplete: "new-password", required: true });
  const err = h("div", { class: "error" });
  card.replaceChildren(
    h("h1", {}, `Join ${info.serverName}`),
    h("p", { class: "muted" }, "You've been invited to help run this Minecraft server. Make an account to get in."),
    h("form", {
      class: "stack",
      onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = "";
        try {
          await api(`/invite/${encodeURIComponent(token)}/accept`, { method: "POST", body: { username: user.value.trim(), password: pass.value } });
          history.replaceState(null, "", "#/");
          onDone();
        } catch (ex) {
          err.textContent = ex.message;
        }
      },
    }, user, pass, err, h("button", { class: "primary", type: "submit" }, "Create account & join"))
  );
  user.focus();
}
