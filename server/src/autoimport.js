import { getSetting, setSetting, listServers, audit } from "./db.js";
import { slugify } from "./setups/common.js";

const PLACEHOLDER = `echo "Console: set the real start command in this server's Settings tab, then press Start."; exec bash`;

// On the very first start, add what is already running (tmux sessions, Docker containers, your own systemd services)
// so the dashboard isn't empty. It only ever runs once: if you remove something later, it stays removed.
export async function autoImport({ db, discover }) {
  if (getSetting(db, "autoimport_done", "0") === "1") return { skipped: true, added: [] };
  const taken = new Set(listServers(db).map((s) => s.id));
  const added = [];
  const add = (base, name, type, target) => {
    let id = slugify(base) || type;
    for (let n = 2; taken.has(id); n++) id = `${slugify(base).slice(0, 36)}-${n}`;
    taken.add(id);
    db.prepare("INSERT INTO servers (id, name, type, target, source) VALUES (?, ?, ?, ?, 'ui')").run(id, name, type, JSON.stringify(target));
    added.push({ id, type });
  };
  const safely = async (fn) => {
    try { return await fn(); } catch { return { ok: false }; }
  };

  const t = await safely(() => discover.tmux());
  for (const s of t.sessions ?? []) {
    if (s.managedBy || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(s.name)) continue;
    add(s.name, s.name, "tmux", { session: s.name, startCommand: s.command || PLACEHOLDER, ...(s.cwd ? { cwd: s.cwd } : {}) });
  }
  const d = await safely(() => discover.docker());
  for (const c of d.containers ?? []) {
    if (c.managedBy || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(c.name)) continue;
    add(c.name, c.name, "docker", { container: c.name });
  }
  const y = await safely(() => discover.systemd());
  for (const u of y.units ?? []) {
    if (u.vendor || u.self || u.managedBy || u.active !== "active") continue; // only services you installed yourself
    add(u.unit.replace(/\.service$/, ""), u.description || u.unit, "systemd", { host: "local", unit: u.unit, sudo: true });
  }

  setSetting(db, "autoimport_done", "1");
  audit(db, { username: "system", action: "autoimport", ok: true, detail: `${added.length} found` });
  return { skipped: false, added };
}
