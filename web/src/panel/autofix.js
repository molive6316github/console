import { h, api, toast, field } from "../ui.js";
import { followJob } from "../views/create.js";

const SCOPES = [["minecraft", "Minecraft server problems (crashes, won't start)"], ["console", "Console itself (panel bugs, failed updates)"], ["plugins", "Console plugins you installed"], ["link", "Console Link (hub and jar)"]];
const STATE = { fixed: ["✓ Fixed", "good"], reverted: ["↩ Didn't work, put back", "wait"], nochange: ["– Nothing safe to change", "wait"], failed: ["✗ Failed", "bad"], running: ["… Working", "wait"], undone: ["↩ Undone", "wait"] };

export async function autofixPage(box, { life }) {
  const root = h("div", { class: "stack wide" });
  box.append(root);

  async function draw() {
    const s = await api("/autofix");
    if (life.dead) return;
    const save = async (patch) => { try { await api("/autofix", { method: "PUT", body: patch }); await draw(); } catch (e) { toast(e.message, true); } };
    const agent = h("select", {}, ...s.agents.map((a) => h("option", { value: a.id }, `${a.label}${a.installed ? "" : a.id === "custom" ? "" : " (not installed)"}`)));
    agent.value = s.agent;
    agent.addEventListener("change", () => save({ agent: agent.value }));
    const custom = h("input", { value: s.custom, placeholder: 'e.g. aider --yes --message "$CONSOLE_TASK"', spellcheck: "false", autocomplete: "off" });
    const on = h("input", { type: "checkbox", checked: s.enabled });
    on.addEventListener("change", () => save({ enabled: on.checked }));
    root.replaceChildren(
      h("div", { class: "panel warn" },
        h("h2", {}, "Auto-fix"),
        h("p", { class: "muted" }, "When something breaks, an AI agent reads what Console found, edits the config or code, restarts, and checks it worked. If it didn't work, everything is put back. Each fix is listed below with the files it changed, and you can undo it."),
        h("p", { class: "muted small" }, "Fully automatic means no approval step. It never touches worlds or player data, can't run shell commands, and stops after a few tries, but it does change files on its own. Worth leaving off until you trust it."),
        h("label", { class: "row" }, on, h("b", {}, "Fix problems automatically"))),
      h("div", { class: "panel" },
        h("h2", {}, "Which agent"),
        h("p", { class: "muted small" }, "Console doesn't care which one. Claude Code and Codex are built in; or type any command that can edit files. Your command runs in the folder being fixed with the task in $CONSOLE_TASK (also in the file $CONSOLE_TASK_FILE)."),
        field("Agent", agent),
        s.agent === "custom" ? field("Command", custom, "Runs with sh -c") : null,
        s.agent === "custom" ? h("div", { class: "row" }, h("button", { onclick: () => save({ custom: custom.value }) }, "Save command")) : null,
        s.agent === "claude" ? h("p", { class: "muted small" }, "Claude Code: turn it on and sign in under Panel settings → Claude Code.") : null,
        s.agent === "codex" ? h("p", { class: "muted small" }, "Codex: install it for Console's user (npm install --prefix ~/.console-tools @openai/codex) and sign in once from the web terminal.") : null),
      h("div", { class: "panel" },
        h("h2", {}, "What it may fix"),
        ...SCOPES.map(([k, text]) => { const c = h("input", { type: "checkbox", checked: Boolean(s.scopes[k]) }); c.addEventListener("change", () => save({ scopes: { [k]: c.checked } })); return h("label", { class: "row" }, c, text); })),
      historyPanel(s.history, draw)
    );
  }

  function historyPanel(items, reload) {
    return h("div", { class: "panel" }, h("h2", {}, "Recent fixes"),
      items.length ? null : h("p", { class: "muted" }, "Nothing yet."),
      ...items.map((f) => {
        const [label, cls] = STATE[f.state] ?? ["", ""];
        return h("div", { class: "stack" },
          h("div", { class: "row" }, h("b", {}, f.title), h("span", { class: cls }, label), h("span", { class: "muted small" }, `${new Date(f.at).toLocaleString()} · ${f.actor} · ${f.agent}`)),
          f.summary ? h("pre", { class: "snippet" }, f.summary) : null,
          f.changed?.length ? h("div", { class: "muted small" }, "Changed: " + f.changed.map((c) => `${c.file} (${c.change})`).join(", ")) : null,
          f.verify ? h("div", { class: "muted small" }, `Check: ${f.verify}`) : null,
          f.state === "fixed" ? h("div", { class: "row" }, h("button", { onclick: async () => { try { await api(`/autofix/${f.id}/undo`, { method: "POST", body: {} }); toast("Undone"); reload(); } catch (e) { toast(e.message, true); } } }, "Undo this fix")) : null);
      }));
  }

  draw().catch((e) => root.replaceChildren(h("div", { class: "error" }, e.message)));
}

// The "Fix it" button used on the Diagnose card.
export function fixItButton(scope, target, note, after) {
  const out = h("div", { class: "stack wide" });
  const btn = h("button", { onclick: async () => {
    btn.disabled = true;
    try {
      const r = await api("/autofix/run", { method: "POST", body: { scope, target, note } });
      out.replaceChildren();
      followJob(out, r.jobId, { onDone: () => { btn.disabled = false; after?.(); } });
    } catch (e) { btn.disabled = false; toast(e.message, true); }
  } }, "Fix it with AI");
  return h("div", { class: "stack wide" }, h("div", { class: "row" }, btn, h("span", { class: "muted small" }, "Uses the agent set on the Auto-fix page. Changes are backed up and put back if they don't work.")), out);
}
