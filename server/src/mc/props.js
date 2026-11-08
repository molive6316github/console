// server.properties: read, validate and write while keeping comments, order and everything we don't touch.
export class McError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const bool = { type: "bool" };
const int = (min, max) => ({ type: "int", min, max });
const sel = (...options) => ({ type: "select", options });

// What the form shows (and the only keys the simple form writes). Anything else is "other".
export const SCHEMA = [
  { key: "motd", label: "Message of the day", group: "Basics", type: "text", max: 200 },
  { key: "max-players", label: "Max players", group: "Basics", ...int(1, 10000) },
  { key: "gamemode", label: "Default game mode", group: "Basics", ...sel("survival", "creative", "adventure", "spectator") },
  { key: "difficulty", label: "Difficulty", group: "Basics", ...sel("peaceful", "easy", "normal", "hard") },
  { key: "pvp", label: "Players can fight each other (PvP)", group: "Basics", ...bool },
  { key: "hardcore", label: "Hardcore (one life)", group: "Basics", ...bool },
  { key: "white-list", label: "Whitelist (only listed players can join)", group: "Access", ...bool },
  { key: "enforce-whitelist", label: "Kick non-whitelisted players when the whitelist turns on", group: "Access", ...bool },
  { key: "online-mode", label: "Verify players with Mojang (turn off only for cracked/proxy setups)", group: "Access", ...bool },
  { key: "spawn-protection", label: "Spawn protection radius", group: "World", ...int(0, 1000) },
  { key: "view-distance", label: "View distance (chunks)", group: "Performance", ...int(2, 32) },
  { key: "simulation-distance", label: "Simulation distance (chunks)", group: "Performance", ...int(3, 32) },
  { key: "allow-flight", label: "Allow flying (needed by some mods/plugins)", group: "World", ...bool },
  { key: "allow-nether", label: "Nether enabled", group: "World", ...bool },
  { key: "spawn-monsters", label: "Monsters spawn", group: "World", ...bool },
  { key: "spawn-animals", label: "Animals spawn", group: "World", ...bool },
  { key: "spawn-npcs", label: "Villagers spawn", group: "World", ...bool },
  { key: "generate-structures", label: "Generate structures (villages etc.)", group: "World", ...bool },
  { key: "enable-command-block", label: "Command blocks work", group: "World", ...bool },
  { key: "force-gamemode", label: "Force default game mode on join", group: "Basics", ...bool },
  { key: "player-idle-timeout", label: "Kick idle players after (minutes, 0 = never)", group: "Access", ...int(0, 100000) },
  { key: "level-seed", label: "World seed (only used when the world is first made)", group: "World", type: "text", max: 100 },
  { key: "level-name", label: "World folder name (changing it starts a new world!)", group: "World", type: "text", max: 60, pattern: /^[A-Za-z0-9._-]+$/, danger: true },
  { key: "server-port", label: "Port", group: "Network", ...int(1024, 65535), danger: true },
];
const BY_KEY = new Map(SCHEMA.map((f) => [f.key, f]));
const SECRET = /(password|secret|token)/i;
const OTHER_KEY = /^[a-z0-9][a-z0-9._-]{0,60}$/;

export function parse(text) {
  const lines = text.split("\n");
  const values = {};
  for (const l of lines) {
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    values[l.slice(0, i).trim()] = l.slice(i + 1).replace(/\r$/, "");
  }
  return { lines, values };
}

export function view(text) {
  const { values } = parse(text);
  const known = SCHEMA.map((f) => ({ ...f, pattern: undefined, value: values[f.key] ?? null }));
  const other = Object.entries(values)
    .filter(([k]) => !BY_KEY.has(k))
    .map(([key, value]) => ({ key, value: SECRET.test(key) ? "" : value, secret: SECRET.test(key) }));
  return { known, other };
}

function checkValue(f, raw) {
  const v = String(raw ?? "");
  if (/[\r\n\0]/.test(v)) throw new McError(`${f.label}: can't contain line breaks`);
  if (f.type === "bool") {
    if (v !== "true" && v !== "false") throw new McError(`${f.label}: must be on or off`);
  } else if (f.type === "int") {
    if (!/^\d{1,9}$/.test(v) || Number(v) < f.min || Number(v) > f.max) throw new McError(`${f.label}: must be a whole number from ${f.min} to ${f.max}`);
  } else if (f.type === "select") {
    if (!f.options.includes(v)) throw new McError(`${f.label}: pick one of ${f.options.join(", ")}`);
  } else {
    if (v.length > (f.max ?? 200)) throw new McError(`${f.label}: too long`);
    if (f.pattern && !f.pattern.test(v)) throw new McError(`${f.label}: use only letters, numbers, dot, dash and underscore`);
  }
  return v;
}

// changes: { key: value }. Known keys are checked against the schema; other keys must look like a property name.
export function apply(text, changes) {
  const { lines, values } = parse(text);
  const out = [...lines];
  const set = (k, v) => {
    const idx = out.findIndex((l) => !l.startsWith("#") && l.split("=")[0].trim() === k);
    const line = `${k}=${v}`;
    if (idx >= 0) out[idx] = line;
    else {
      while (out.length && out[out.length - 1] === "") out.pop();
      out.push(line, "");
    }
  };
  let n = 0;
  for (const [k, raw] of Object.entries(changes ?? {})) {
    const f = BY_KEY.get(k);
    let v;
    if (f) v = checkValue(f, raw);
    else {
      if (!OTHER_KEY.test(k)) throw new McError(`"${k}" isn't a valid property name`);
      if (SECRET.test(k) && String(raw) === "") continue; // blank secret field = leave as is
      v = String(raw ?? "");
      if (/[\r\n\0]/.test(v) || v.length > 500) throw new McError(`${k}: value isn't allowed`);
    }
    if (values[k] !== v) (set(k, v), n++);
  }
  return { text: out.join("\n"), changed: n };
}
