import { h, api, toast, field } from "../ui.js";

// A chat with the built-in assistant. It can do whatever the signed-in person can do; risky steps wait for a click here.
export async function assistantPage(box, { me, life }) {
  const root = h("div", { class: "stack wide" });
  box.append(root);
  let busy = false;
  let timer = null;
  life?.onStop?.(() => clearTimeout(timer));

  const log = h("div", { class: "chatlog" });
  const approvalsBox = h("div", { class: "stack" });
  const input = h("textarea", { rows: "2", placeholder: "Ask anything, or tell it what to do. e.g. \"why was it laggy last night?\" or \"whitelist Steve and restart\"", maxlength: "2000" });
  const send = h("button", { class: "primary" }, "Send");

  const bubble = (role, text) => h("div", { class: `bubble ${role}` }, h("div", { class: "who" }, role === "user" ? me.username : "Assistant"), h("div", { class: "msg" }, text));
  const scroll = () => { log.scrollTop = log.scrollHeight; };

  function drawApprovals(list) {
    approvalsBox.replaceChildren(...list.map((a) => h("div", { class: "panel warn" },
      h("b", {}, "The assistant wants to do this:"),
      h("pre", { class: "snippet" }, a.summary),
      h("div", { class: "row" },
        h("button", { class: "primary", onclick: () => decide(a.id, true) }, "Approve"),
        h("button", { onclick: () => decide(a.id, false) }, "No")))));
  }
  async function decide(id, approve) {
    try { await api(`/assistant/approvals/${id}`, { method: "POST", body: { approve } }); } catch (e) { toast(e.message, true); }
  }

  async function poll(turnId, thinking) {
    try {
      const t = await api(`/assistant/turns/${turnId}`);
      if (life?.dead) return;
      drawApprovals(t.approvals);
      if (t.state === "running") { timer = setTimeout(() => poll(turnId, thinking), 1500); return; }
      thinking.replaceWith(bubble("assistant", t.reply));
      busy = false; send.disabled = false; drawApprovals([]); scroll();
    } catch (e) { thinking.replaceWith(bubble("assistant", `Lost the thread: ${e.message}`)); busy = false; send.disabled = false; }
  }

  async function ask() {
    const text = input.value.trim();
    if (!text || busy) return;
    busy = true; send.disabled = true; input.value = "";
    log.append(bubble("user", text));
    const thinking = h("div", { class: "bubble assistant" }, h("div", { class: "who" }, "Assistant"), h("div", { class: "msg muted" }, "Working on it…"));
    log.append(thinking); scroll();
    try { const r = await api("/assistant/message", { method: "POST", body: { text } }); poll(r.turnId, thinking); }
    catch (e) { thinking.replaceWith(bubble("assistant", e.message)); busy = false; send.disabled = false; }
  }
  send.addEventListener("click", ask);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } });

  async function draw() {
    const s = await api("/assistant");
    if (life?.dead) return;
    log.replaceChildren(...s.history.map((m) => bubble(m.role, m.text)));
    drawApprovals(s.approvals);
    const chat = h("div", { class: "panel" },
      h("h2", {}, "Assistant"),
      s.canUse
        ? h("p", { class: "muted small" }, `Ask it things or tell it what to do. It acts as you (${me.role === "admin" ? "an owner, so everything" : "with your permissions only"}). Stopping, restarting, deleting and restoring always wait for your OK.`)
        : h("div", { class: "panel warn" }, h("p", {}, s.reason)),
      log, approvalsBox,
      s.canUse ? h("div", { class: "stack wide" }, input, h("div", { class: "row" }, send, h("button", { onclick: async () => { await api("/assistant/history", { method: "DELETE" }); draw(); } }, "Clear chat"))) : null);
    root.replaceChildren(chat, me.role === "admin" ? settings(s) : null);
    scroll();
  }

  function settings(s) {
    const save = async (patch) => { try { await api("/assistant", { method: "PUT", body: patch }); await draw(); } catch (e) { toast(e.message, true); } };
    const on = h("input", { type: "checkbox", checked: s.enabled });
    on.addEventListener("change", () => save({ enabled: on.checked }));
    const agent = h("select", {}, ...s.agents.map((a) => h("option", { value: a.id }, `${a.label}${a.installed ? "" : a.id === "custom" ? "" : " (not installed)"}${a.restricted ? "" : " · owners only"}`)));
    agent.value = s.agent;
    agent.addEventListener("change", () => save({ agent: agent.value }));
    const custom = h("input", { value: s.custom ?? "", placeholder: 'e.g. aider --message "$CONSOLE_TASK"', spellcheck: "false", autocomplete: "off" });
    return h("div", { class: "panel" },
      h("h2", {}, "Assistant settings"),
      h("p", { class: "muted small" }, "Owners only. The assistant is one agent for the whole panel; each person who asks gets only what their own role allows."),
      h("label", { class: "row" }, on, h("b", {}, "Turn the assistant on")),
      field("Agent", agent, "Claude Code is the sandboxed one: it can only use the panel, nothing else on the machine. Other agents can't be limited like that, so only owners may use them."),
      s.agent === "custom" ? field("Command", custom, "Runs with sh -c. The question and a tool called console-ctl are available; the question is in $CONSOLE_TASK.") : null,
      s.agent === "custom" ? h("div", { class: "row" }, h("button", { onclick: () => save({ custom: custom.value }) }, "Save command")) : null,
      s.agent === "claude" ? h("p", { class: "muted small" }, "Claude Code: turn it on and sign in under Panel settings → Claude Code.") : null);
  }

  draw().catch((e) => root.replaceChildren(h("div", { class: "error" }, e.message)));
}
