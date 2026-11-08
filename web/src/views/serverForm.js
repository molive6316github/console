import { h, field } from "../ui.js";

// One definition per server type: what to ask for. Keys match the driver's validate().
export const TYPES = {
  tmux: {
    label: "Game server in tmux",
    hint: "Runs a command in a tmux session on this machine. Good for Minecraft and friends. You get logs and a command box.",
    fields: [
      { key: "session", label: "Session name", required: true, help: "Letters, numbers, dashes. For example: survival", placeholder: "survival" },
      { key: "startCommand", label: "Start command", required: true, help: "Runs on this machine as the console user.", placeholder: "java -Xmx4G -jar server.jar nogui" },
      { key: "cwd", label: "Folder to run in", help: "Absolute path. Also becomes the file editor / backup folder.", placeholder: "/srv/survival" },
      { key: "stopCommand", label: "Stop command", help: "Typed into the server to shut it down nicely (Minecraft: stop). Without one, the session is just killed.", placeholder: "stop" },
      { key: "stopTimeoutSec", label: "Seconds to wait for a graceful stop", kind: "number", placeholder: "30" },
      { key: "filesRoot", label: "Files folder (if different)", help: "Folder for the file editor and backups.", placeholder: "/srv/survival" },
    ],
  },
  docker: {
    label: "Docker container",
    hint: "Start, stop and restart an existing container. Console's user must be in the docker group.",
    fields: [
      { key: "container", label: "Container name", required: true, placeholder: "my-app" },
      { key: "filesRoot", label: "Files folder", help: "Optional. Turns on the file editor and backups for a folder on this machine.", placeholder: "/srv/my-app" },
    ],
  },
  systemd: {
    label: "systemd service (over SSH)",
    hint: "Controls a service on any Linux machine. Needs key-based SSH from this box.",
    fields: [
      { key: "host", label: "SSH host", required: true, help: "user@host", placeholder: "root@10.0.0.5" },
      { key: "unit", label: "Service", required: true, placeholder: "nginx.service" },
      { key: "port", label: "SSH port", kind: "number", placeholder: "22" },
      { key: "sudo", label: "Use sudo on the remote machine", kind: "bool" },
      { key: "keyFile", label: "SSH key file", help: "Absolute path on this machine.", placeholder: "/home/console/.ssh/id_ed25519" },
    ],
  },
  http: {
    label: "Website check (read-only)",
    hint: "Just checks whether a URL answers. Can't start or stop anything.",
    fields: [
      { key: "url", label: "URL", required: true, placeholder: "https://example.com" },
      { key: "expectStatus", label: "Expected status code", kind: "number", help: "Leave empty for any 2xx.", placeholder: "200" },
      { key: "timeoutMs", label: "Timeout (ms)", kind: "number", placeholder: "4000" },
    ],
  },
  dummy: {
    label: "Fake (for trying things out)",
    hint: "Does nothing for real. Handy for testing schedules and alerts.",
    fields: [
      { key: "startsUp", label: "Starts as running", kind: "bool" },
      { key: "filesRoot", label: "Files folder", help: "Optional, for trying the file editor.", placeholder: "/tmp/playground" },
    ],
  },
};

// Builds the add / edit form. `existing` = { id, name, type, target } when editing.
export function serverForm({ existing, prefill, onSubmit, onCancel }) {
  const editing = Boolean(existing);
  const src = existing ?? prefill;
  const id = h("input", { value: src?.id ?? "", disabled: editing, placeholder: "survival-smp", pattern: "[a-z0-9][a-z0-9\\-]*", required: true });
  const name = h("input", { value: src?.name ?? "", placeholder: "Survival SMP", required: true, maxlength: "80" });
  const type = h("select", {}, Object.entries(TYPES).map(([k, t]) => h("option", { value: k, selected: k === (src?.type ?? "tmux") }, t.label)));
  const fieldsBox = h("div", { class: "stack" });
  const hint = h("p", { class: "muted" });
  const msg = h("div", { class: "error" });
  let inputs = {};

  function drawFields() {
    const t = TYPES[type.value];
    hint.textContent = t.hint;
    inputs = {};
    const old = src && src.type === type.value ? src.target : {};
    fieldsBox.replaceChildren(
      ...t.fields.map((f) => {
        let el;
        if (f.kind === "bool") el = h("input", { type: "checkbox", checked: Boolean(old[f.key]) });
        else el = h("input", { type: f.kind === "number" ? "number" : "text", value: old[f.key] ?? "", placeholder: f.placeholder ?? "", required: f.required });
        inputs[f.key] = { el, f };
        return f.kind === "bool" ? h("label", { class: "check" }, el, f.label) : field(f.label + (f.required ? " *" : ""), el, f.help);
      })
    );
  }
  type.addEventListener("change", drawFields);
  drawFields();

  const form = h(
    "form",
    {
      class: "stack wide",
      onsubmit: async (e) => {
        e.preventDefault();
        msg.textContent = "";
        const target = {};
        for (const [key, { el, f }] of Object.entries(inputs)) {
          if (f.kind === "bool") target[key] = el.checked;
          else if (el.value.trim() !== "") target[key] = f.kind === "number" ? Number(el.value) : el.value.trim();
        }
        try {
          await onSubmit({ id: id.value.trim(), name: name.value.trim(), type: type.value, target });
        } catch (err) {
          msg.textContent = err.message;
        }
      },
    },
    !editing && field("ID", id, "Used in the address and the audit log. Lowercase letters, numbers, dashes. Can't be changed later."),
    field("Name", name),
    field("Type", type),
    hint,
    fieldsBox,
    msg,
    h("div", { class: "row" }, h("button", { class: "primary", type: "submit" }, editing ? "Save changes" : "Add server"), onCancel && h("button", { type: "button", onclick: onCancel }, "Cancel"))
  );
  return form;
}

// Pass a discovered thing to the "new server" screen.
let pending = null;
export const setPrefill = (p) => {
  pending = p;
};
export const takePrefill = () => {
  const p = pending;
  pending = null;
  return p;
};
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "server";
