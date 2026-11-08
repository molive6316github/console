import { promises as fs } from "node:fs";
import path from "node:path";
import { McError } from "./props.js";
import { mcRoot } from "./index.js";
import { parseStart } from "./startup.js";
import { getDriver } from "../drivers/index.js";

// Things that show up in a Minecraft log when it dies, and what they mean in plain words.
export const LOG_CLUES = [
  { re: /You need to agree to the EULA/i, say: "The EULA hasn't been accepted. Turn it on in Go-live checklist (first row) and start again." },
  { re: /Address already in use|FAILED TO BIND|Perhaps a server is already running/i, say: "Something else already uses the game port. Another copy of the server is probably still running." },
  { re: /OutOfMemoryError|Cannot allocate memory|insufficient memory|Could not reserve enough space/i, say: "The server asked for more memory than the machine could give. Lower it on Startup & memory." },
  { re: /UnsupportedClassVersionError|requires Java|class file version/i, say: "This Minecraft version needs a newer (or older) Java than the one it was started with." },
  { re: /Invalid or corrupt jarfile|Unable to access jarfile|ZipException/i, say: "server.jar is missing or damaged. Re-install the version on the Version page." },
  { re: /Failed to load properties|Failed to start the minecraft server/i, say: "The server couldn't read its settings. Check server.properties on Game settings." },
  { re: /Exception in thread "main"|Caused by:/i, say: "The server hit an error while booting. The red lines in the log below say what." },
];

export const readMemAvailMb = async () => {
  try {
    const m = /MemAvailable:\s+(\d+) kB/.exec(await fs.readFile("/proc/meminfo", "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch { return null; }
};

// One click that does what we'd otherwise do over ssh: is it running, is Java OK, is there memory, why did it stop.
export function createDiagnose({ mc, run, memAvailMb = readMemAvailMb }) {
  async function diagnose(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const out = [];
    const add = (id, label, state, detail) => out.push({ id, label, state, detail });

    const live = await mc.liveStatus(server).catch(() => null);
    const state = live?.state ?? "stopped";
    const exit = live?.exit?.code;
    const says = {
      online: ["ok", "Online and answering players."],
      starting: ["warn", "The process is alive but isn't answering players yet. A first start can take a minute or two; if it stays like this, check the log lines below."],
      crashed: ["bad", `The server process exited by itself${exit != null ? ` (exit code ${exit})` : ""}. The reason should be in the log lines below.`],
      stopped: ["bad", "Not running. Press Start on Overview."],
    }[state];
    add("process", "Server process", says[0], says[1]);

    const parsed = parseStart(server.target?.startCommand);
    const java = parsed?.java ?? String(server.target?.startCommand ?? "").split(/\s+/)[0];
    if (java) {
      const v = await run(java, ["-version"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      const line = (v.stderr || v.stdout).split("\n")[0]?.trim();
      add("java", "Java", v.code === 0 ? "ok" : "bad", v.code === 0 ? line : `Can't run "${java}". Re-run Create/Version so Console reinstalls Java.`);
    }

    const avail = await memAvailMb();
    if (parsed?.memoryMb && avail) {
      const tight = parsed.memoryMb > avail * 0.9;
      add("memory", "Memory", tight ? "bad" : parsed.memoryMb > avail * 0.7 ? "warn" : "ok", `The server is set to use ${parsed.memoryMb} MB and the machine has about ${avail} MB free right now.${tight ? " That's too much: lower it on Startup & memory." : ""}`);
    }

    const jar = path.join(root, parsed?.jar ?? "server.jar");
    add("jar", "Server jar", (await fs.stat(jar).then((s) => s.size > 1_000_000).catch(() => false)) ? "ok" : "bad", `${path.basename(jar)} ${(await fs.stat(jar).catch(() => null)) ? "is there." : "is missing."}`);

    const eula = await fs.readFile(path.join(root, "eula.txt"), "utf8").catch(() => "");
    add("eula", "EULA", /eula\s*=\s*true/i.test(eula) ? "ok" : "bad", /eula\s*=\s*true/i.test(eula) ? "Accepted." : "Not accepted: the server refuses to start.");

    // The last output: what the terminal printed (survives a crash) plus the log file.
    let tail = "";
    try { tail = await getDriver(server.type).logs?.(server.target, 80, { id: server.id }); } catch { /* none */ }
    const logFile = await fs.readFile(path.join(root, "logs", "latest.log"), "utf8").catch(() => "");
    const text = `${tail ?? ""}\n${logFile.split("\n").slice(-80).join("\n")}`;
    const clues = LOG_CLUES.filter((c) => c.re.test(text));
    if (clues.length) for (const c of clues) add("clue", "Found in the log", "bad", c.say);
    else if (state === "crashed" || state === "stopped") add("clue", "Why it stopped", "info", "No known error in the log. Read the last lines below; a log that just ends usually means something killed the process.");

    const worst = out.some((c) => c.state === "bad") ? "bad" : out.some((c) => c.state === "warn") ? "warn" : "ok";
    const lines = (tail?.trim() || logFile).split("\n").filter(Boolean).slice(-25).join("\n");
    return { state, verdict: worst, checks: out, log: lines };
  }
  return { diagnose };
}
