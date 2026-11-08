import { readdirSync } from "node:fs";
import path from "node:path";
import { ID, listServers } from "../db.js";
import { JobFailure } from "../jobs.js";

export class SetupError extends Error {
  status = 400;
}

export const str = (v, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export function slugify(s) {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// Name + id pair every template starts with. The id becomes a folder name and a container/session name, so it is strict.
export function nameAndId(inp, db, fallback) {
  const name = str(inp.name, 80) || fallback;
  const id = str(inp.id, 60) || slugify(name);
  if (!name) throw new SetupError("Give it a name");
  if (!ID.test(id)) throw new SetupError("The ID can only use lowercase letters, numbers and dashes");
  if (listServers(db).some((s) => s.id === id)) throw new SetupError(`Something called "${id}" already exists in Console. Pick another name.`);
  return { name, id };
}

export function intIn(v, min, max, label, fallback) {
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new SetupError(`${label} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new SetupError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}

// KEY=value lines -> [[KEY, value]]. Used for .env files and docker -e flags.
export function parseEnvText(text) {
  const out = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]{0,63})\s*=(.*)$/);
    if (!m) throw new SetupError(`Environment lines look like NAME=value. This one doesn't: "${line.slice(0, 40)}"`);
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v.length > 2000 || v.includes("\0")) throw new SetupError(`The value for ${m[1]} is too long`);
    out.push([m[1], v]);
  }
  if (out.length > 60) throw new SetupError("That's a lot of environment variables (60 max)");
  return out;
}

// Quote a value for a .env file that a shell will `source`.
export const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

export function javaMajorOf(output) {
  const m = String(output).match(/version "(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}

export function javaNeededFor(mcVersion) {
  const m = String(mcVersion).match(/^1\.(\d+)(?:\.(\d+))?/);
  if (!m) return 25;
  const minor = Number(m[1]);
  const patch = Number(m[2] ?? 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

export async function commandExists(run, cmd) {
  const r = await run("sh", ["-c", `command -v ${cmd}`]);
  return r.code === 0 && r.stdout.trim() !== "";
}

// Finds a java binary of at least `need`. Checks PATH first, then /usr/lib/jvm.
export async function findJava(run, need, jvmDir = "/usr/lib/jvm") {
  const probe = async (bin) => {
    const r = await run(bin, ["-version"]);
    return r.code === 0 ? javaMajorOf(r.stdout + r.stderr) : null;
  };
  const inPath = await probe("java");
  if (inPath !== null && inPath >= need) return { bin: "java", major: inPath };
  let best = null;
  try {
    for (const d of readdirSync(jvmDir)) {
      const bin = path.join(jvmDir, d, "bin", "java");
      const major = await probe(bin);
      if (major !== null && major >= need && (!best || major < best.major)) best = { bin, major };
    }
  } catch {
    /* no jvm dir */
  }
  return best;
}

export async function detectPm(run) {
  for (const pm of ["dnf", "yum", "apt-get"]) if (await commandExists(run, pm)) return pm;
  return null;
}

export const fail = (msg) => new JobFailure(msg);
