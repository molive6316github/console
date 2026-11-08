import { McError } from "./props.js";

// The start command is typed into a tmux shell, so every token we build must be boring and safe.
// We never keep a free-form command: we parse the one we wrote, change known fields, and rebuild it.

export const FLAG_PRESETS = {
  none: { label: "Default", blurb: "Java's own defaults. Fine for small servers.", flags: [] },
  aikar: {
    label: "Optimized (Aikar's flags)",
    blurb: "The community-standard G1GC tuning for Paper/Purpur. Smoother with more players.",
    flags: [
      "-XX:+UseG1GC", "-XX:+ParallelRefProcEnabled", "-XX:MaxGCPauseMillis=200", "-XX:+UnlockExperimentalVMOptions",
      "-XX:+DisableExplicitGC", "-XX:+AlwaysPreTouch", "-XX:G1NewSizePercent=30", "-XX:G1MaxNewSizePercent=40",
      "-XX:G1HeapRegionSize=8M", "-XX:G1ReservePercent=20", "-XX:G1HeapWastePercent=5", "-XX:G1MixedGCCountTarget=4",
      "-XX:InitiatingHeapOccupancyPercent=15", "-XX:G1MixedGCLiveThresholdPercent=90", "-XX:G1RSetUpdatingPauseTimePercent=5",
      "-XX:SurvivorRatio=32", "-XX:+PerfDisableSharedMem", "-XX:MaxTenuringThreshold=1",
    ],
  },
};

const JAVA_BIN = /^\/?[A-Za-z0-9_./+-]{1,200}$/;
const JAR = /^[A-Za-z0-9_.+-]{1,80}\.jar$/;
// Anything that can run code, read/write files or load an agent is refused.
const DENY_NAME = /(OnError|OnOutOfMemory|File|Path|Agent|Flags|Arguments|Compile|Command|Dump|Log|Debug|Jdwp|Attach)/i;

export function checkCustomFlag(raw) {
  const f = String(raw ?? "").trim();
  if (!f) return null;
  if (f.length > 80) throw new McError(`That flag is too long: ${f.slice(0, 20)}…`, 400);
  if (/^-Xss\d{1,5}[kKmM]$/.test(f)) return f;
  let m = /^-XX:([+-])([A-Za-z][A-Za-z0-9]{2,60})$/.exec(f);
  if (!m) m = /^-XX:([A-Za-z][A-Za-z0-9]{2,60})=([0-9]{1,9}[kKmMgG]?|[0-9]{1,3})$/.exec(f);
  if (m) {
    const name = m.length === 3 && (m[1] === "+" || m[1] === "-") ? m[2] : m[1];
    if (DENY_NAME.test(name)) throw new McError(`${f} isn't allowed here (it could run code or touch files)`, 400);
    return f;
  }
  if (/^-Dcom\.mojang\.eula\.agree=true$/.test(f) || /^-Dfile\.encoding=UTF-8$/.test(f) || /^-Dterminal\.jline=false$/.test(f)) return f;
  throw new McError(`Flag not allowed: ${f}. Only -XX: tuning options, -Xss and a few safe -D options work here.`, 400);
}

export function checkMemory(mb) {
  const n = Number(mb);
  if (!Number.isInteger(n) || n < 512 || n > 262144) throw new McError("Memory must be a whole number between 512 and 262144 MB", 400);
  return n;
}

// "/usr/bin/java -Xms2048M -Xmx2048M <flags…> -jar server.jar nogui" → fields, or null if it isn't ours.
export function parseStart(cmd) {
  const t = String(cmd ?? "").trim().split(/\s+/);
  if (t.length < 4 || !JAVA_BIN.test(t[0])) return null;
  const jarAt = t.indexOf("-jar");
  if (jarAt < 1 || !JAR.test(t[jarAt + 1] ?? "")) return null;
  let mx = null;
  const rest = [];
  for (const x of t.slice(1, jarAt)) {
    const m = /^-Xmx(\d+)([MG])$/i.exec(x);
    if (m) mx = Number(m[1]) * (m[2].toUpperCase() === "G" ? 1024 : 1);
    else if (!/^-Xms/.test(x)) rest.push(x);
  }
  if (!mx) return null;
  const aikar = FLAG_PRESETS.aikar.flags;
  const hasAikar = aikar.every((f) => rest.includes(f));
  const custom = rest.filter((f) => !(hasAikar && aikar.includes(f)));
  return { java: t[0], memoryMb: mx, preset: hasAikar ? "aikar" : "none", custom, jar: t[jarAt + 1] };
}

export function buildStart({ java, memoryMb, preset = "none", custom = [], jar = "server.jar" }) {
  if (!JAVA_BIN.test(java)) throw new McError("Bad Java path", 400);
  if (!JAR.test(jar)) throw new McError("Bad jar name", 400);
  if (!FLAG_PRESETS[preset]) throw new McError("Unknown flag preset", 400);
  const mem = checkMemory(memoryMb);
  const cleaned = [...new Set(custom.map(checkCustomFlag).filter(Boolean))];
  if (cleaned.length > 30) throw new McError("Too many custom flags (30 max)", 400);
  const heap = `${mem}M`;
  // Aikar's flags want Xms == Xmx; we always do that.
  return [java, `-Xms${heap}`, `-Xmx${heap}`, ...FLAG_PRESETS[preset].flags, ...cleaned, "-jar", jar, "nogui"].join(" ");
}

const DEFAULTS = { autoRestart: true, dailyRestart: null };
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

// "04:30" → a "say" five minutes before, then the restart itself.
export function restartCrons(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  const t = (h * 60 + m + 1440 - 5) % 1440;
  return { warn: `${t % 60} ${Math.floor(t / 60)} * * *`, go: `${m} ${h} * * *` };
}

export function createStartup({ getServer, saveTarget, cfgGet, cfgSet, validateTarget, setDaily = () => {}, hostMemMb = () => null, now = () => Date.now() }) {
  const restarts = new Map(); // server id -> timestamps of automatic restarts

  const settings = (id) => ({ ...DEFAULTS, ...(cfgGet(id) ?? {}) });

  function view(server) {
    const p = parseStart(server.target?.startCommand);
    if (!p) throw new McError("This server wasn't set up by Console, so its start command can't be edited here. Use Settings → advanced instead.", 400);
    return {
      memoryMb: p.memoryMb,
      preset: p.preset,
      customFlags: p.custom,
      jar: p.jar,
      presets: Object.entries(FLAG_PRESETS).map(([id, v]) => ({ id, label: v.label, blurb: v.blurb })),
      hostMemMb: hostMemMb(),
      ...settings(server.id),
    };
  }

  // Applies on the next start; never touches a running server.
  function update(server, body = {}) {
    const p = parseStart(server.target?.startCommand);
    if (!p) throw new McError("This server wasn't set up by Console, so its start command can't be edited here.", 400);
    const next = {
      java: p.java,
      jar: p.jar,
      memoryMb: body.memoryMb === undefined ? p.memoryMb : checkMemory(body.memoryMb),
      preset: body.preset === undefined ? p.preset : body.preset,
      custom: body.customFlags === undefined ? p.custom : Array.isArray(body.customFlags) ? body.customFlags : null,
    };
    if (!next.custom) throw new McError("customFlags must be a list", 400);
    const total = hostMemMb();
    if (total && next.memoryMb > total * 0.9) throw new McError(`That's more than 90% of this machine's ${total} MB of RAM. The server would get killed.`, 400);
    const startCommand = buildStart(next);
    const target = validateTarget(server.type, { ...server.target, startCommand });
    saveTarget(server.id, target);

    const cur = settings(server.id);
    const s = { ...cur };
    if (body.autoRestart !== undefined) s.autoRestart = body.autoRestart === true;
    if (body.dailyRestart !== undefined) {
      if (body.dailyRestart !== null && !HHMM.test(body.dailyRestart)) throw new McError("Daily restart time must look like 04:30", 400);
      s.dailyRestart = body.dailyRestart;
      setDaily(server.id, body.dailyRestart);
    }
    cfgSet(server.id, s);
    return { ...view(getServer(server.id)), restartNeeded: true };
  }

  // Called by the monitor when a server that should be up has been confirmed down.
  // Gives up after 3 automatic restarts in 30 minutes so a crash loop doesn't thrash the box.
  async function onCrash(server, perform) {
    if (!parseStart(server.target?.startCommand)) return { restarted: false }; // only Console-made Minecraft servers
    if (!settings(server.id).autoRestart) return { restarted: false };
    const t = now();
    const recent = (restarts.get(server.id) ?? []).filter((x) => t - x < 30 * 60_000);
    if (recent.length >= 3) return { restarted: false, gaveUp: true };
    recent.push(t);
    restarts.set(server.id, recent);
    try {
      await perform(server, "start", "auto-restart");
      return { restarted: true, attempt: recent.length };
    } catch (e) {
      return { restarted: false, error: e.message };
    }
  }

  return { view, update, onCrash, settings, DEFAULTS };
}
