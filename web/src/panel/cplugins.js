import { h, api, toast, field } from "../ui.js";
import { followJob } from "../views/create.js";

const label = (o) => (typeof o === "string" ? o : (o.label ?? o.value));
const value = (o) => (typeof o === "string" ? o : o.value);

export async function consolePluginsPage(box, { life }) {
  const list = h("div", { class: "stack wide" }, h("p", { class: "muted" }, "Loading…"));
  const builder = h("div", { class: "panel" });
  box.append(
    h("div", { class: "panel warn" }, h("h2", {}, "Console plugins"), h("p", { class: "muted" }, "Add-ons for Console itself: a public API for your website, leaderboards, a Discord bot, themes, and anything you (or Claude) write. They run inside Console with its full access, so only switch on plugins you trust.")),
    list, builder
  );

  async function drawList() {
    const { plugins, folder } = await api("/cplugins");
    list.replaceChildren(
      ...plugins.map(pluginCard),
      h("p", { class: "muted small" }, `Your own plugins go in ${folder}/<name>/ (manifest.json + index.js). See PLUGINS.md in the Console folder for how to write one.`)
    );
  }

  function pluginCard(p) {
    const inputs = {};
    const fields = p.settings.map((s) => {
      let el;
      if (s.type === "bool") el = h("input", { type: "checkbox", checked: Boolean(s.value) });
      else if (s.type === "select") { el = h("select", {}, ...(s.options ?? []).map((o) => h("option", { value: value(o) }, label(o)))); el.value = s.value; }
      else if (s.type === "textarea") el = h("textarea", { rows: "4", value: s.value ?? "" });
      else if (s.type === "number") el = h("input", { type: "number", value: s.value ?? 0, min: s.min, max: s.max });
      else if (s.type === "color") el = h("input", { type: "color", value: s.value || "#4ade80" });
      else if (s.type === "secret") el = h("input", { type: "password", autocomplete: "off", placeholder: s.hasValue ? "(saved, leave blank to keep)" : "" });
      else el = h("input", { type: "text", value: s.value ?? "", autocomplete: "off" });
      inputs[s.key] = [s, el];
      return s.type === "bool" ? h("label", { class: "check" }, el, s.label ?? s.key) : field(s.label ?? s.key, el, s.help);
    });
    const read = () => Object.fromEntries(Object.entries(inputs).map(([k, [s, el]]) => [k, s.type === "bool" ? el.checked : el.value]));
    const send = async (body, msg) => {
      try { await api(`/cplugins/${encodeURIComponent(p.id)}`, { method: "PUT", body }); toast(msg); await drawList(); } catch (e) { toast(e.message, true); }
    };
    const statusText = p.error ? p.error : p.status === "running" ? "Running" : p.status === "error" ? `Couldn't start: ${p.runError}` : "Off";
    return h("div", { class: "panel" },
      h("div", { class: "row" },
        h("h2", {}, p.name), h("span", { class: "muted small" }, `v${p.version}${p.builtin ? " · built in" : ""}`),
        h("label", { class: "check" }, h("input", { type: "checkbox", checked: p.enabled, disabled: Boolean(p.error), onchange: (e) => send({ enabled: e.target.checked }, e.target.checked ? "Turned on" : "Turned off") }), "On")),
      h("p", { class: "muted" }, p.description),
      h("p", { class: p.status === "running" ? "good small" : "muted small" }, statusText),
      p.permissions.length ? h("ul", { class: "small muted" }, ...p.permissions.map((x) => h("li", {}, x))) : null,
      p.enabled && p.permissions.some((x) => x.includes("/x/")) ? h("p", { class: "small" }, "Public address: ", h("code", {}, `${location.origin}/x/${p.id}/`)) : null,
      fields.length ? h("details", {}, h("summary", {}, "Settings"), h("div", { class: "stack wide" }, ...fields, h("div", { class: "row" }, h("button", { class: "primary", onclick: () => send({ settings: read() }, "Saved") }, "Save settings")))) : null,
      p.enabled && p.actions.length ? h("div", { class: "row" }, ...p.actions.map((a) => h("button", { onclick: async () => {
        try { const r = await api(`/x/${encodeURIComponent(p.id)}${a.path}`.replace(/^\/x/, "/x"), { method: "POST", body: {} }); toast(r.error ?? "Done", Boolean(r.error)); } catch (e) { toast(e.message, true); }
      } }, a.label))) : null
    );
  }

  const prompt = h("textarea", { rows: "4", placeholder: "Example: Every time a player reaches 10 hours of playtime, announce it in chat and give them a diamond.", maxlength: "2000" });
  const out = h("div", {});
  const draftsBox = h("div", { class: "stack wide" });
  async function drawDrafts() {
    const { drafts } = await api("/cplugins/drafts");
    draftsBox.replaceChildren(...drafts.map((d) => {
      const code = h("pre", { class: "snippet", hidden: true });
      return h("div", { class: "panel" },
        h("b", {}, d.name), h("p", { class: "muted small" }, d.request),
        d.error ? h("div", { class: "error" }, d.error) : null,
        code,
        h("div", { class: "row" },
          h("button", { onclick: async () => { if (!code.hidden) { code.hidden = true; return; } const { files } = await api(`/cplugins/drafts/${d.id}`); code.textContent = Object.entries(files).map(([n, t]) => `// ${n}\n${t}`).join("\n\n"); code.hidden = false; } }, "Review the code"),
          h("button", { class: "primary", disabled: !d.ready, onclick: async () => { try { await api(`/cplugins/drafts/${d.id}/install`, { method: "POST", body: {} }); toast("Installed (it's off until you turn it on above)"); await drawList(); } catch (e) { toast(e.message, true); } } }, "Install"),
          h("button", { onclick: async () => { await api(`/cplugins/drafts/${d.id}`, { method: "DELETE" }); drawDrafts(); } }, "Discard")));
    }));
  }
  builder.append(
    h("h2", {}, "Build a plugin with Claude"),
    h("p", { class: "muted" }, "Describe what you want. Claude Code (signed in on this server) writes it as a draft. You read the code, then install it. It stays off until you switch it on. Needs Claude Code enabled in Panel settings."),
    h("div", { class: "stack wide" }, prompt, h("div", { class: "row" }, h("button", { class: "primary", onclick: async () => {
      try {
        const r = await api("/cplugins/build", { method: "POST", body: { prompt: prompt.value } });
        out.replaceChildren();
        followJob(out, r.jobId, { life, onDone: () => drawDrafts() });
      } catch (e) { toast(e.message, true); }
    } }, "Build it"))),
    out, draftsBox
  );
  drawList().catch((e) => list.replaceChildren(h("div", { class: "error" }, e.message)));
  drawDrafts().catch(() => {});
}
