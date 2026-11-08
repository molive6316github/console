import "@xterm/xterm/css/xterm.css";
import "./style.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

const state = document.getElementById("state");
const again = document.getElementById("again");
const box = document.getElementById("term");
const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", theme: { background: "#0e1116", foreground: "#e6e9ef" } });
const fit = new FitAddon();
term.loadAddon(fit);
term.open(box);
fit.fit();

let ws = null;
const send = (obj) => ws?.readyState === 1 && ws.send(JSON.stringify(obj));

function connect() {
  again.hidden = true;
  state.textContent = "connecting…";
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/api/terminal?cols=${term.cols}&rows=${term.rows}${new URLSearchParams(location.search).get("run") === "claude" ? "&run=claude" : ""}`);
  ws.onopen = () => {
    state.textContent = "connected";
    term.focus();
  };
  ws.onmessage = (e) => term.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
  ws.onclose = () => {
    state.textContent = "disconnected";
    again.hidden = false;
  };
}
term.onData((d) => send({ t: "in", d }));
term.onResize(({ cols, rows }) => send({ t: "resize", cols, rows }));
new ResizeObserver(() => fit.fit()).observe(box);
again.addEventListener("click", () => {
  term.reset();
  connect();
});
connect();
