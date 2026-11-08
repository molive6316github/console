import { promises as fs, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { run } from "../drivers/exec.js";
import { McError, parse } from "./props.js";

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

// Put a backup back. The server must be off. Nothing is deleted: the current folder is moved aside next to it.
export async function restoreBackup({ root, file }) {
  const rootReal = realpathSync(root);
  const list = await run("tar", ["-tzf", file], { timeout: 120_000 });
  if (list.code !== 0) throw new McError("That backup file can't be read");
  for (const entry of list.stdout.split("\n").filter(Boolean)) {
    const parts = entry.split("/");
    if (entry.startsWith("/") || parts.includes("..")) throw new McError("That backup contains unsafe paths, so it wasn't restored");
  }
  const ts = stamp();
  const tmp = `${rootReal}.restoring-${ts}`;
  const aside = `${rootReal}.before-restore-${ts}`;
  await fs.mkdir(tmp, { mode: 0o755 });
  try {
    const x = await run("tar", ["-xzf", file, "-C", tmp, "--no-same-owner"], { timeout: 15 * 60_000 });
    if (x.code !== 0) throw new McError(`Couldn't unpack the backup: ${x.stderr.trim().split("\n").pop()}`);
    if (!existsSync(path.join(tmp, "server.properties"))) throw new McError("That backup doesn't look like a Minecraft server (no server.properties), so it wasn't restored");
    await fs.rename(rootReal, aside);
    try {
      await fs.rename(tmp, rootReal);
    } catch (e) {
      await fs.rename(aside, rootReal); // put everything back
      throw new McError(`Couldn't swap the folders: ${e.message}`, 500);
    }
  } catch (e) {
    await fs.rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return { previousKeptAt: aside };
}

// Starts a fresh world: moves the current world folders into old-worlds/<time>/ (nothing is deleted).
export async function resetWorld({ root }) {
  const props = parse(await fs.readFile(path.join(root, "server.properties"), "utf8")).values;
  const level = props["level-name"] || "world";
  if (!/^[A-Za-z0-9._-]+$/.test(level) || level.includes("..")) throw new McError("The world folder name in server.properties isn't safe to touch");
  const dest = path.join(root, "old-worlds", stamp());
  const moved = [];
  for (const d of [level, `${level}_nether`, `${level}_the_end`]) {
    const from = path.join(root, d);
    if (!existsSync(from)) continue;
    await fs.mkdir(dest, { recursive: true });
    await fs.rename(from, path.join(dest, d));
    moved.push(d);
  }
  if (!moved.length) throw new McError("There's no world folder to reset yet");
  return { movedTo: path.relative(root, dest), moved };
}
