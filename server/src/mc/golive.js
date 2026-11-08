import { promises as fs } from "node:fs";
import path from "node:path";
import { McError } from "./props.js";
import { mcRoot } from "./index.js";
import { BUNDLES } from "./catalog.js";

const readJson = async (f) => { try { const x = JSON.parse(await fs.readFile(f, "utf8")); return Array.isArray(x) ? x : []; } catch { return []; } };

// "Is this ready for real players?" Each check says what's wrong in plain words and, where Console can, how to fix it in one click.
export function createGoLive({ db, mc, startup, offsite, run, getSetting, hostMemMb }) {
  async function checks(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const out = [];
    const add = (id, group, label, state, detail, fix) => out.push({ id, group, label, state, detail, ...(fix ? { fix } : {}) });

    const pv = await mc.getProps(server);
    const props = Object.fromEntries([...pv.known, ...pv.other].map((x) => [x.key, x.value]));
    const eula = await fs.readFile(path.join(root, "eula.txt"), "utf8").catch(() => "");
    add("eula", "Basics", "Minecraft EULA accepted", /eula\s*=\s*true/i.test(eula) ? "ok" : "bad", "The server won't start until the EULA is accepted.");
    const status = await mc.runtimeStatus(server);
    add("running", "Basics", "Server is running", status === "up" ? "ok" : "bad", status === "up" ? "Online." : "It's stopped. Start it from Overview.");
    add("online-mode", "Basics", "Verifies players with Mojang (online-mode)", String(props["online-mode"]) === "false" ? "warn" : "ok", String(props["online-mode"]) === "false" ? "Anyone can join as anyone, including as an admin. Only leave this off behind a proxy." : "Good.");

    const port = await mc.portOf(server).catch(() => 25565);
    const fw = await run("sh", ["-c", `command -v firewall-cmd >/dev/null && firewall-cmd --query-port=${port}/tcp`]);
    const fwOpen = fw.stdout.trim() === "yes";
    add("firewall", "Reachable", `Port ${port} open on this machine's firewall`, fwOpen ? "ok" : "warn", fwOpen ? "Open." : "No firewall rule found (or no firewalld here). If friends can't connect, this is the first place to look.");
    add("vcn", "Reachable", "Cloud firewall allows the game port", "info", `Oracle Cloud blocks everything until you add an ingress rule for TCP ${port} (Networking → VCN → Security List). Console can't see that from here. Ask a friend to try joining to confirm.`);

    const domain = getSetting("join_domain", "");
    add("domain", "Reachable", "A join address players can remember", domain ? "ok" : "warn", domain ? `Players join with ${domain}. Check the DNS records on "Join address & status page".` : "Players would have to type your IP. Set a domain on the Join address page.");

    const whitelistOn = String(props["white-list"]) === "true";
    add("whitelist", "Safety", "Whitelist on while you set things up", whitelistOn ? "ok" : "warn", whitelistOn ? "Only listed players can join. Turn it off when you open to the public." : "Anyone can join right now. Turn this on until you're ready to open the doors.", whitelistOn ? null : { id: "whitelist", label: "Turn whitelist on" });
    const ops = await readJson(path.join(root, "ops.json"));
    add("ops", "Safety", "At least one operator (admin) in game", ops.length ? "ok" : "warn", ops.length ? `${ops.length} operator${ops.length === 1 ? "" : "s"}.` : "Nobody can use admin commands in game. Add yourself on the Players page.");

    let plug = [];
    try { plug = (await mc.plugins.list(server)).files.filter((f) => f.enabled).map((f) => String(f.file).toLowerCase()); } catch { /* vanilla or no plugins folder */ }
    const has = (n) => plug.some((f) => f.includes(n));
    add("protect", "Safety", "Grief rollback and protection plugins", has("coreprotect") && (has("worldguard") || has("huskclaims")) ? "ok" : has("coreprotect") ? "warn" : "bad", has("coreprotect") ? "CoreProtect is installed." : "Without a rollback plugin, one griefer can ruin the world with no undo.", has("coreprotect") ? null : { id: "protect", label: "Install the staff & protection bundle" });
    add("ranks", "Safety", "Ranks and permissions (LuckPerms)", has("luckperms") ? "ok" : "warn", has("luckperms") ? "Installed." : "You'll want ranks for staff, builders and players.", has("luckperms") ? null : { id: "protect", label: "Install the staff & protection bundle" });

    const sched = db.prepare("SELECT action, cron, enabled FROM schedules WHERE server_id = ?").all(server.id).map((r) => ({ ...r }));
    const dailyBackup = sched.some((r) => r.enabled && /backup/.test(r.action));
    add("backup", "Backups", "Automatic world backups", dailyBackup ? "ok" : "bad", dailyBackup ? "A backup is scheduled." : "No backups are scheduled. One bad day and the world is gone.", dailyBackup ? null : { id: "backup", label: "Back up every night at 3:30" });
    const off = offsite.view();
    add("offsite", "Backups", "A copy of backups off this machine", off.configured ? "ok" : "warn", off.configured ? `Copying to ${off.bucket}.` : "Backups on the same disk die with the disk. Add free storage (Oracle, Backblaze, R2) under Backups.");

    let st = null;
    try { st = startup.view(server); } catch { /* not made by Console */ }
    if (st) {
      add("crash", "Stability", "Restarts itself after a crash", st.autoRestart ? "ok" : "warn", st.autoRestart ? "On." : "Off. A crash at 3am stays down until you notice.", st.autoRestart ? null : { id: "crash", label: "Turn on" });
      add("daily", "Stability", "Daily restart (keeps lag away)", st.dailyRestart ? "ok" : "warn", st.dailyRestart ? `Restarts at ${st.dailyRestart} with a 5 minute warning.` : "A nightly restart clears memory leaks. Pick a quiet hour.", st.dailyRestart ? null : { id: "daily", label: "Restart daily at 4:30" });
      const total = hostMemMb();
      const ratio = total ? st.memoryMb / total : 0;
      add("ram", "Stability", "Memory sized for this machine", ratio > 0.8 ? "bad" : st.memoryMb < 3072 ? "warn" : "ok", `${Math.round(st.memoryMb / 1024 * 10) / 10} GB for the server of ${total ? Math.round(total / 1024) : "?"} GB total.${st.memoryMb < 3072 ? " Fine for a few friends; give it 4-8 GB for a public server." : ""}`, st.memoryMb < 3072 && ratio < 0.5 ? { id: "ram", label: "Set to 6 GB" } : null);
    }
    add("alerts", "Stability", "Get told when it goes down (Discord)", getSetting("alert_webhook", "") ? "ok" : "warn", getSetting("alert_webhook", "") ? "A webhook is set." : "Paste a Discord or Slack webhook in Panel settings and Console pings you when the server dies.");
    const bad = out.filter((c) => c.state === "bad").length, warn = out.filter((c) => c.state === "warn").length;
    return { checks: out, summary: { bad, warn, ready: bad === 0 && warn === 0 } };
  }

  async function fix(server, id) {
    switch (id) {
      case "whitelist":
        await mc.setProps(server, { "white-list": true, "enforce-whitelist": true });
        return { message: "Whitelist is on. It applies after the next restart. Add players on the Players page." };
      case "crash":
        startup.update(server, { autoRestart: true });
        return { message: "Console will restart the server if it crashes (max 3 times in 30 minutes)." };
      case "daily":
        startup.update(server, { dailyRestart: "04:30" });
        return { message: "Daily restart at 04:30, with a warning 5 minutes before." };
      case "ram": {
        startup.update(server, { memoryMb: 6144 });
        return { message: "Memory set to 6 GB. It applies after the next restart." };
      }
      case "backup":
        db.prepare("INSERT INTO schedules (server_id, action, arg, cron, enabled, created_by) VALUES (?, 'mc-backup', NULL, '30 3 * * *', 1, 'panel:golive')").run(server.id);
        return { message: "A safe world backup will run every night at 03:30." };
      case "protect": {
        const slugs = BUNDLES.find((b) => b.id === "golive").slugs;
        const r = await mc.plugins.installMany(server, slugs, undefined);
        const done = r.results.filter((x) => x.ok && !x.skipped).map((x) => x.slug);
        const failed = r.results.filter((x) => !x.ok).map((x) => x.slug);
        return { message: `Installed: ${done.join(", ") || "nothing new"}.${failed.length ? ` Couldn't install: ${failed.join(", ")} (not available for this version).` : ""} Restart the server to load them.`, restartNeeded: true };
      }
      default:
        throw new McError("Unknown fix", 400);
    }
  }

  return { checks, fix };
}
