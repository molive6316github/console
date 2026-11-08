// Fake driver for development. State lives in memory only.
const state = new Map();

function get(target, key) {
  const k = JSON.stringify(target) + key;
  if (!state.has(k)) state.set(k, Boolean(target?.startsUp));
  return k;
}

import { clean, pickPath } from "./exec.js";

export default {
  type: "dummy",
  validate: (t) => clean({ startsUp: Boolean(t.startsUp), filesRoot: pickPath(t, "filesRoot") }),
  async status(target, ctx) {
    return state.get(get(target, ctx.id)) ? "up" : "down";
  },
  async start(target, ctx) {
    state.set(get(target, ctx.id), true);
  },
  async stop(target, ctx) {
    state.set(get(target, ctx.id), false);
  },
  async restart(target, ctx) {
    state.set(get(target, ctx.id), true);
  },
  async logs(target, lines, ctx) {
    return `[dummy] ${ctx?.id ?? "server"} is a fake server for trying out Console.\n[dummy] Nothing is really running.`;
  },
};
