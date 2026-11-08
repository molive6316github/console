import "./style.css";
import "./panel/panel.css";
import { h } from "./ui.js";

const app = document.getElementById("app");

async function draw() {
  let s;
  try {
    const res = await fetch("/api/public/status", { credentials: "omit" });
    s = await res.json();
  } catch {
    s = null;
  }
  if (!s || !s.enabled) {
    app.replaceChildren(h("div", { class: "pubcard" }, h("h1", {}, "Status page is off"), h("p", { class: "muted" }, "The owner hasn't turned this page on.")));
    return;
  }
  app.replaceChildren(
    h("div", { class: "pubcard" },
      h("h1", {}, s.name),
      h("div", { class: `state-pill ${s.online ? "up" : "down"}` }, h("span", { class: `dot ${s.online ? "up" : "down"}` }), s.online ? "Online" : "Offline"),
      s.online ? h("div", { class: "pubnum" }, `${s.players.online}`, h("span", {}, ` / ${s.players.max} players`)) : null,
      s.online && s.players.names?.length ? h("div", { class: "chips" }, ...s.players.names.map((n) => h("span", { class: "chip" }, n))) : null,
      s.address ? h("div", { class: "pubaddr" }, h("div", { class: "label" }, "Join with"), h("code", { class: "bigaddr" }, s.address)) : null,
      s.online && s.version ? h("p", { class: "muted small" }, `Version ${s.version}`) : null
    )
  );
}
draw();
setInterval(() => !document.hidden && draw(), 15000);
