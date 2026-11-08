import { promises as fs, existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { getDriver } from "../drivers/index.js";
import { filesRootOf } from "../runtime.js";
import { McError, view, apply } from "./props.js";
import { buildCommand, parseList } from "./players.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The folder, if (and only if) it is a Minecraft server: it has a server.properties.
export function mcRoot(server) {
  const root = filesRootOf(server);
  if (!root) return null;
  try {
    return existsSync(path.join(root, "server.properties")) ? realpathSync(root) : null;
  } catch {
    return null;
  }
}

export function mcKind(root) {
  if (existsSync(path.join(root, "mods"))) return "mods";
  return "plugins";
}

async function readJson(file) {
  try {
    const v = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function createMc({ runtime, listWaitMs = 900 }) {
  async function getProps(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server (no server.properties in its folder)", 404);
    return view(await fs.readFile(path.join(root, "server.properties"), "utf8"));
  }

  async function setProps(server, changes) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const file = path.join(root, "server.properties");
    const before = await fs.readFile(file, "utf8");
    const { text, changed } = apply(before, changes);
    if (!changed) return { changed: 0 };
    await fs.writeFile(`${file}.console-bak`, before);
    const tmp = `${file}.console-tmp`;
    await fs.writeFile(tmp, text);
    await fs.rename(tmp, file);
    return { changed };
  }

  // Asks the running server for its player list and reads the answer back from its console.
  async function players(server) {
    const root = mcRoot(server);
    if (!root) throw new McError("This isn't a Minecraft server", 404);
    const driver = getDriver(server.type);
    const status = await runtime.status(server).catch(() => "unknown");
    const lists = {
      whitelist: (await readJson(path.join(root, "whitelist.json"))).map((p) => p.name).filter(Boolean),
      ops: (await readJson(path.join(root, "ops.json"))).map((p) => p.name).filter(Boolean),
      banned: (await readJson(path.join(root, "banned-players.json"))).map((p) => ({ name: p.name, reason: p.reason })).filter((p) => p.name),
    };
    if (status !== "up" || !driver.send) return { up: false, ...lists };
    try {
      await driver.send(server.target, "list", { id: server.id });
      await sleep(listWaitMs);
      const out = await driver.logs(server.target, 40);
      return { up: true, ...(parseList(out) ?? { count: null, max: null, players: [] }), ...lists };
    } catch (e) {
      return { up: true, count: null, max: null, players: [], error: e.message, ...lists };
    }
  }

  async function act(server, actor, action, body) {
    if (!mcRoot(server)) throw new McError("This isn't a Minecraft server", 404);
    const cmd = buildCommand(action, body);
    await runtime.perform(server, "command", actor, cmd);
    return { ok: true, command: cmd };
  }

  return { getProps, setProps, players, act };
}
