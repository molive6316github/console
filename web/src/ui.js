// Small DOM helper. Everything goes through textContent / text nodes, so server data can't inject HTML.
const SVG_NS = "http://www.w3.org/2000/svg";

// replaceChildren/append turn null and false into the literal text "null"/"false". Skip them like h() does.
for (const m of ["replaceChildren", "append", "prepend"]) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false)); };
}

function apply(el, props) {
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") el.setAttribute("class", v);
    else if (k === "value") el.value = v;
    else if (k === "checked" || k === "disabled" || k === "hidden" || k === "selected") el[k] = Boolean(v);
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? "" : v);
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
}

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  apply(el, props);
  append(el, children);
  return el;
}

export function svg(tag, props = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props)) if (v != null && v !== false) el.setAttribute(k, v);
  append(el, children);
  return el;
}

export async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) {
    const err = new Error(data?.error ?? `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    if (res.status === 401 && path !== "/login") window.dispatchEvent(new Event("console:signed-out"));
    throw err;
  }
  return data;
}

let toastTimer = null;
export function toast(msg, bad = false) {
  document.querySelector(".toast")?.remove();
  clearTimeout(toastTimer);
  const t = h("div", { class: `toast${bad ? " bad" : ""}`, role: "status" }, msg);
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), bad ? 6000 : 3500);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function bytes(n) {
  if (n == null) return "-";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

export function when(ms) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function duration(sec) {
  const d = Math.floor(sec / 86400);
  const hrs = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${hrs}h` : hrs ? `${hrs}h ${m}m` : `${m}m`;
}

export const sqlTime = (s) => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" }) : "-");

// A labelled form row. `control` is any input element.
export function field(label, control, help) {
  return h("label", { class: "field" }, h("span", {}, label), control, help && h("small", {}, help));
}

export function dot(status) {
  return h("span", { class: `dot ${status}`, title: status });
}

// Every view gets one of these: timers it starts are cleared when you navigate away.
export function lifecycle() {
  const timers = [];
  const cleanups = [];
  let dead = false;
  return {
    onStop(fn) {
      cleanups.push(fn);
    },
    get dead() {
      return dead;
    },
    every(fn, ms) {
      const t = setInterval(() => {
        if (!document.hidden && !dead) fn();
      }, ms);
      timers.push(t);
    },
    stop() {
      dead = true;
      timers.forEach(clearInterval);
      cleanups.forEach((fn) => fn());
    },
  };
}

// A view with unsaved work registers a function that says so; the router asks before navigating away.
let leaveGuard = null;
export const setLeaveGuard = (fn) => {
  leaveGuard = fn;
};
export const hasUnsavedWork = () => Boolean(leaveGuard?.());
