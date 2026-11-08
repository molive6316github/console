// Fine-grained permissions for people you invite to a server. Owners (role admin) can do everything.
// A user with no stored permissions gets the defaults for their role, so existing accounts behave exactly as before.
export const PERMS = [
  { id: "console", label: "See the console", help: "Read the live server output" },
  { id: "send", label: "Type commands", help: "Run any command in the server console" },
  { id: "power", label: "Start, stop, restart", help: "Control the server power" },
  { id: "players", label: "Manage players", help: "Whitelist, kick, ban, op, gamemode, say" },
  { id: "settings", label: "Game settings", help: "Edit server.properties" },
  { id: "startup", label: "Startup & memory", help: "RAM, Java flags, auto-restart, restart schedule" },
  { id: "versions", label: "Change version", help: "Switch Minecraft version or server software", danger: true },
  { id: "plugins", label: "Plugins & mods", help: "Install or remove plugins and mods. They run code on your server.", danger: true },
  { id: "files", label: "File manager", help: "Edit any file in the server folder", danger: true },
  { id: "backups", label: "Backups & worlds", help: "Create, download, restore and reset worlds", danger: true },
  { id: "activity", label: "See activity log", help: "Who did what on this server" },
];
export const PERM_IDS = PERMS.map((p) => p.id);

export const PRESETS = {
  helper: { label: "Helper", perms: ["console", "players"], help: "Can watch the console and manage players" },
  moderator: { label: "Moderator", perms: ["console", "send", "power", "players", "activity"], help: "Also types commands and restarts the server" },
  admin: { label: "Admin", perms: ["console", "send", "power", "players", "settings", "startup", "versions", "plugins", "files", "backups", "activity"], help: "Everything except managing people" },
};

const ROLE_DEFAULTS = {
  admin: PERM_IDS,
  operator: ["console", "send", "power", "players"],
  viewer: ["console"],
};

export function validatePerms(list) {
  if (!Array.isArray(list)) return null;
  const clean = [...new Set(list)];
  if (clean.some((p) => !PERM_IDS.includes(p))) return null;
  return PERM_IDS.filter((p) => clean.includes(p));
}

export function parsePerms(raw, role) {
  if (role === "admin") return PERM_IDS;
  if (raw) {
    try {
      const v = validatePerms(JSON.parse(raw));
      if (v) return v;
    } catch { /* fall through to the role default */ }
  }
  return ROLE_DEFAULTS[role] ?? [];
}

export const hasPerm = (user, perm) => Boolean(user) && (user.role === "admin" || (user.perms ?? []).includes(perm));
