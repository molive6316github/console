import { McError } from "./props.js";

const NAME = /^\.?[A-Za-z0-9_]{1,16}$/; // the dot is Bedrock/Floodgate players

export function name(p) {
  if (typeof p !== "string" || !NAME.test(p)) throw new McError("That isn't a valid player name");
  return p;
}
// Free text typed into a chat/kick message. Line breaks would let one message become a second command, so they're removed.
export function text(t, max) {
  const s = String(t ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, max);
  return s;
}
const oneOf = (v, list, label) => {
  if (!list.includes(v)) throw new McError(`${label} must be one of: ${list.join(", ")}`);
  return v;
};

// Every quick action maps to a fixed command template. Nothing the browser sends is ever used as a command.
export const ACTIONS = {
  kick: (b) => `kick ${name(b.player)}${text(b.reason, 100) ? ` ${text(b.reason, 100)}` : ""}`,
  ban: (b) => `ban ${name(b.player)}${text(b.reason, 100) ? ` ${text(b.reason, 100)}` : ""}`,
  pardon: (b) => `pardon ${name(b.player)}`,
  op: (b) => `op ${name(b.player)}`,
  deop: (b) => `deop ${name(b.player)}`,
  "whitelist-add": (b) => `whitelist add ${name(b.player)}`,
  "whitelist-remove": (b) => `whitelist remove ${name(b.player)}`,
  "whitelist-on": () => "whitelist on",
  "whitelist-off": () => "whitelist off",
  "whitelist-reload": () => "whitelist reload",
  say: (b) => {
    const t = text(b.message, 200);
    if (!t) throw new McError("Type a message first");
    return `say ${t}`;
  },
  "save-all": () => "save-all",
  time: (b) => `time set ${oneOf(b.value, ["day", "noon", "night", "midnight"], "Time")}`,
  weather: (b) => `weather ${oneOf(b.value, ["clear", "rain", "thunder"], "Weather")}`,
  difficulty: (b) => `difficulty ${oneOf(b.value, ["peaceful", "easy", "normal", "hard"], "Difficulty")}`,
  gamemode: (b) => `gamemode ${oneOf(b.value, ["survival", "creative", "adventure", "spectator"], "Game mode")} ${name(b.player)}`,
};

export function buildCommand(action, body) {
  const f = ACTIONS[action];
  if (!f) throw new McError("Unknown action");
  return f(body ?? {});
}

// "There are 2 of a max of 20 players online: Steve, Alex"  (also the older "There are 2/20 players online:")
export function parseList(output) {
  const re = /There are (\d+)(?: of a max of |\/)(\d+) players online:?\s*([^\n\r]*)/g;
  let m;
  let last = null;
  while ((m = re.exec(output))) last = m;
  if (!last) return null;
  const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
  return { count: Number(last[1]), max: Number(last[2]), players: clean(last[3]).split(",").map((p) => p.trim()).filter((p) => NAME.test(p)) };
}
