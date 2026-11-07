// Fake driver for development. State lives in memory only.
const state = new Map();

function get(target, key) {
  const k = JSON.stringify(target) + key;
  if (!state.has(k)) state.set(k, Boolean(target?.startsUp));
  return k;
}

export default {
  type: "dummy",
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
  async logs() {
    return "dummy driver: no logs";
  },
};
