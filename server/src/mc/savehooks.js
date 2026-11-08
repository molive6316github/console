import { existsSync } from "node:fs";
import path from "node:path";
import { getDriver } from "../drivers/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SAVED = /Saved the (game|world)|ThreadedAnvilChunkStorage: All dimensions are saved|All chunks are saved/g;
const count = (s) => (String(s).match(SAVED) ?? []).length;

// Before copying a live world, ask Minecraft to stop writing and flush to disk; afterwards turn saving back on.
// Returns null when this isn't a running Minecraft server (nothing to do). Otherwise a function that MUST be called to resume.
export async function pauseSaves(server, root, { status, waitMs = 30_000, pollMs = 300 } = {}) {
  if (!root || !existsSync(path.join(root, "server.properties"))) return null;
  const driver = getDriver(server.type);
  if (!driver.send) return null;
  if ((await status(server).catch(() => "unknown")) !== "up") return null;
  const before = count(await driver.logs(server.target, 200).catch(() => ""));
  await driver.send(server.target, "save-off");
  let resumed = false;
  const resume = async () => {
    if (resumed) return;
    resumed = true;
    for (let i = 0; i < 3; i++) {
      try {
        await driver.send(server.target, "save-on");
        return;
      } catch {
        await sleep(500);
      }
    }
  };
  try {
    await driver.send(server.target, "save-all flush");
    const end = Date.now() + waitMs;
    let confirmed = false;
    while (Date.now() < end) {
      await sleep(pollMs);
      if (count(await driver.logs(server.target, 200).catch(() => "")) > before) {
        confirmed = true;
        break;
      }
    }
    if (!confirmed) await sleep(Math.min(3000, waitMs)); // couldn't see the confirmation (log trimmed?): give it a moment anyway
  } catch (e) {
    await resume();
    throw e;
  }
  return resume;
}
