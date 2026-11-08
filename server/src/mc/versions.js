import path from "node:path";
import { rename, copyFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { McError } from "./props.js";
import { parseStart, buildStart } from "./startup.js";
import { FLAVORS, resolveDownload, download, ensureJava } from "../setups/minecraft.js";
import { javaNeededFor } from "../setups/common.js";

const tuple = (v) => String(v).split(".").map((x) => parseInt(x, 10) || 0);
export function isOlder(a, b) {
  const x = tuple(a), y = tuple(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  }
  return false;
}

// One-click version/flavor switch. The server must be stopped; a full backup is taken first and the old jar is kept.
export function createVersions({ jobs, fetchImpl, runtime, getMeta, saveMeta, saveTarget, validateTarget, run, mustBeStopped, needConfirm, resolve = resolveDownload, dl = download, java = ensureJava }) {
  async function switchTo(server, root, body, actor) {
    const flavor = String(body.flavor ?? "");
    const version = String(body.version ?? "");
    if (!FLAVORS[flavor]) throw new McError("Pick Paper, Vanilla, Purpur or Fabric", 400);
    if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new McError("Pick a Minecraft version", 400);
    const meta = getMeta(server.id) ?? {};
    if (meta.kind !== "minecraft") throw new McError("Console can only switch versions on servers it set up itself.", 400);
    const start = parseStart(server.target?.startCommand);
    if (!start) throw new McError("This server's start command isn't one Console made, so it can't be switched automatically.", 400);
    needConfirm(server, body.confirm);
    await mustBeStopped(server);
    const flavorChange = meta.flavor !== flavor;
    const downgrade = meta.version && !flavorChange && isOlder(version, meta.version);
    if (flavorChange && body.acceptFlavorChange !== true) {
      throw new McError("Changing server type can break plugins/mods and sometimes worlds. Tick the box to confirm you know that.", 409);
    }
    if (downgrade && body.acceptDowngrade !== true) {
      throw new McError("Going to an older version can corrupt a world that has been played on a newer one. Tick the box to confirm.", 409);
    }
    if (runtime.busy.has(server.id)) throw new McError("Another action is already running on this server", 409);

    const job = jobs.start({ title: `Switch ${server.name} to ${FLAVORS[flavor].label} ${version}`, actor }, async (ctx) => {
      try {
        ctx.log("Step 1/4: full backup (so you can always go back)");
        await runtime.perform(server, "backup", actor);
        runtime.busy.add(server.id); // from here on nothing else may touch the server

        ctx.log("Step 2/4: finding the download");
        const d = await resolve(fetchImpl, flavor, version);
        const need = d.java ?? javaNeededFor(version);
        const j = await java(need, { run }, ctx);

        ctx.log("Step 3/4: downloading");
        const fresh = path.join(root, `${start.jar}.new`);
        await dl(fetchImpl, d.url, fresh, ctx.log);

        ctx.log("Step 4/4: swapping the server file");
        const jar = path.join(root, start.jar);
        const keep = `${start.jar}.before-${Date.now()}`;
        if (existsSync(jar)) await copyFile(jar, path.join(root, keep));
        await rename(fresh, jar);
        const startCommand = buildStart({ ...start, java: j.bin });
        saveTarget(server.id, validateTarget(server.type, { ...server.target, startCommand }));
        saveMeta(server.id, { ...meta, flavor, version });
        ctx.log(`Done. The old server file is saved as ${keep}. Start the server when you're ready.`);
        if (flavorChange) ctx.log("Heads up: you changed server type. Check your plugins/mods folder and remove anything that doesn't match.");
        return { flavor, version, kept: keep };
      } catch (e) {
        await rm(path.join(root, `${start.jar}.new`), { force: true }).catch(() => {});
        throw e;
      } finally {
        runtime.busy.delete(server.id);
      }
    });
    return job;
  }
  return { switchTo };
}
