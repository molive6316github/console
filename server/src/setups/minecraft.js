import { createWriteStream } from "node:fs";
import { mkdir, writeFile, rename, stat, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { SetupError, nameAndId, intIn, str, javaNeededFor, findJava, detectPm, fail } from "./common.js";

export const FLAVORS = {
  paper: { label: "Paper", blurb: "Fast, plugin-friendly. The usual pick for a survival server." },
  vanilla: { label: "Vanilla", blurb: "Plain Mojang server, no mods or plugins." },
  purpur: { label: "Purpur", blurb: "Paper plus extra gameplay settings." },
  fabric: { label: "Fabric", blurb: "For Fabric mods." },
};

const DOWNLOAD_HOSTS = ["piston-data.mojang.com", "launcher.mojang.com", "fill-data.papermc.io", "fill.papermc.io", "api.papermc.io", "api.purpurmc.org", "meta.fabricmc.net"];
const cmpVersion = (a, b) => {
  const pa = a.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};

async function getJson(fetchImpl, url) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": "console-server-manager" }, signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw fail(`Couldn't reach ${new URL(url).hostname}: ${e.message}`);
  }
  if (!res.ok) throw fail(`${new URL(url).hostname} answered ${res.status} for ${new URL(url).pathname}`);
  return res.json();
}

// ---- version lists (for the picker) ------------------------------------------
export async function listVersions(fetchImpl, flavor) {
  if (flavor === "vanilla") {
    const m = await getJson(fetchImpl, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    return m.versions.filter((v) => v.type === "release").map((v) => v.id);
  }
  if (flavor === "paper") {
    const p = await getJson(fetchImpl, "https://fill.papermc.io/v3/projects/paper");
    const all = Array.isArray(p.versions) ? p.versions : Object.values(p.versions ?? {}).flat();
    return all.filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(cmpVersion);
  }
  if (flavor === "purpur") {
    const p = await getJson(fetchImpl, "https://api.purpurmc.org/v2/purpur");
    return (p.versions ?? []).filter((v) => /^\d+(\.\d+)*$/.test(v)).sort(cmpVersion);
  }
  if (flavor === "fabric") {
    const g = await getJson(fetchImpl, "https://meta.fabricmc.net/v2/versions/game");
    return g.filter((v) => v.stable).map((v) => v.version);
  }
  throw new SetupError("Unknown server type");
}

// ---- where to download a given flavor + version --------------------------------
export async function resolveDownload(fetchImpl, flavor, version) {
  if (flavor === "vanilla") {
    const m = await getJson(fetchImpl, "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json");
    const entry = m.versions.find((v) => v.id === version);
    if (!entry) throw fail(`Minecraft ${version} doesn't exist`);
    const v = await getJson(fetchImpl, entry.url);
    if (!v.downloads?.server?.url) throw fail(`Minecraft ${version} has no server download`);
    return { url: v.downloads.server.url, sha1: v.downloads.server.sha1, java: v.javaVersion?.majorVersion };
  }
  if (flavor === "paper") {
    const b = await getJson(fetchImpl, `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds/latest`);
    const d = b.downloads?.["server:default"];
    if (!d?.url) throw fail(`Paper has no build for ${version}`);
    return { url: d.url, sha256: d.checksums?.sha256 };
  }
  if (flavor === "purpur") {
    return { url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/latest/download` };
  }
  if (flavor === "fabric") {
    const [loaders, installers] = await Promise.all([
      getJson(fetchImpl, "https://meta.fabricmc.net/v2/versions/loader"),
      getJson(fetchImpl, "https://meta.fabricmc.net/v2/versions/installer"),
    ]);
    const loader = loaders.find((l) => l.stable)?.version;
    const installer = installers.find((i) => i.stable)?.version;
    if (!loader || !installer) throw fail("Couldn't work out the latest Fabric loader");
    return { url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${loader}/${installer}/server/jar` };
  }
  throw fail("Unknown server type");
}

async function download(fetchImpl, url, dest, log) {
  const host = new URL(url).hostname;
  if (!DOWNLOAD_HOSTS.includes(host)) throw fail(`Refusing to download from ${host}`);
  const res = await fetchImpl(url, { headers: { "user-agent": "console-server-manager" }, redirect: "follow" }).catch((e) => {
    throw fail(`Download failed: ${e.message}`);
  });
  if (!res.ok || !res.body) throw fail(`Download failed (${res.status})`);
  const finalHost = res.url ? new URL(res.url).hostname : host;
  if (!DOWNLOAD_HOSTS.includes(finalHost)) throw fail(`The download redirected to ${finalHost}, which isn't allowed`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = (await stat(tmp)).size;
  if (size < 100_000) {
    await rm(tmp, { force: true });
    throw fail("The download was too small to be a server. Try again or pick another version.");
  }
  await rename(tmp, dest);
  log(`Downloaded ${(size / 1048576).toFixed(1)} MB`);
  return dest;
}

export default {
  id: "minecraft",
  title: "Minecraft server",
  blurb: "Pick Paper, Vanilla, Purpur or Fabric and a version. Console downloads it, sets it up and starts it.",
  category: "Games",
  level: "simple",
  fields: [
    { key: "name", label: "Server name", type: "text", default: "My Minecraft Server", required: true },
    { key: "flavor", label: "Type", type: "select", options: Object.entries(FLAVORS).map(([value, f]) => ({ value, label: `${f.label}: ${f.blurb}` })), default: "paper" },
    { key: "version", label: "Minecraft version", type: "version", help: "Newest is at the top." },
    { key: "memoryMb", label: "Memory (MB)", type: "number", default: 2048, level: "standard", help: "2048 is fine for a few friends. The free Oracle ARM box has up to 24 GB." },
    { key: "port", label: "Port", type: "number", default: 25565, level: "standard" },
    { key: "openFirewall", label: "Open this port in the server firewall", type: "checkbox", default: true, level: "standard", help: "You also need an Oracle VCN ingress rule for the same port (TCP)." },
    { key: "acceptEula", label: "I agree to the Minecraft EULA (aka.ms/MinecraftEULA)", type: "checkbox", default: false, required: true },
    { key: "id", label: "ID", type: "text", level: "advanced", help: "Used for the folder and tmux session name. Auto-filled from the name." },
  ],
  validate(inp, env) {
    const { name, id } = nameAndId(inp, env.db, "My Minecraft Server");
    const flavor = str(inp.flavor, 20) || "paper";
    if (!FLAVORS[flavor]) throw new SetupError("Pick Paper, Vanilla, Purpur or Fabric");
    const version = str(inp.version, 20);
    if (!/^\d+(\.\d+){1,3}$/.test(version)) throw new SetupError("Pick a Minecraft version");
    if (inp.acceptEula !== true) throw new SetupError("You need to accept the Minecraft EULA to run a server");
    return {
      name, id, flavor, version,
      memoryMb: intIn(inp.memoryMb, 512, 262144, "Memory", 2048),
      port: intIn(inp.port, 1024, 65535, "Port", 25565),
      openFirewall: inp.openFirewall !== false,
    };
  },
  async run(c, ctx, env) {
    const dir = path.join(env.appsDir, c.id);
    await mkdir(dir, { recursive: true });
    ctx.log(`Setting up ${FLAVORS[c.flavor].label} ${c.version} in ${dir}`);

    const dl = await resolveDownload(env.fetch, c.flavor, c.version);
    const need = dl.java ?? javaNeededFor(c.version);
    let java = await findJava(env.run, need);
    if (!java) {
      ctx.log(`This version needs Java ${need}, which isn't installed. Installing it (needs sudo)…`);
      const pm = await detectPm(env.run);
      if (!pm) throw fail(`Install Java ${need} yourself, then try again.`);
      const pkg = pm === "apt-get" ? `openjdk-${need}-jre-headless` : `java-${need}-openjdk-headless`;
      if (pm === "apt-get") await ctx.exec("sudo", ["-n", "apt-get", "update", "-qq"], { allowFail: true });
      await ctx.exec("sudo", ["-n", pm, "install", "-y", pkg]).catch(() => {
        throw fail(`Couldn't install ${pkg}. Console needs passwordless sudo for this (opc has it on Oracle). You can also run: sudo ${pm} install -y ${pkg}`);
      });
      java = await findJava(env.run, need);
      if (!java) throw fail(`Java ${need} still isn't available after installing. Check the log above.`);
    }
    ctx.log(`Using Java ${java.major} (${java.bin})`);

    await download(env.fetch, dl.url, path.join(dir, "server.jar"), ctx.log);
    await writeFile(path.join(dir, "eula.txt"), "# You accepted the Minecraft EULA in Console.\neula=true\n");
    await writeFile(path.join(dir, "server.properties"), `server-port=${c.port}\nmotd=${c.name.replace(/[\r\n\\]/g, " ")}\n`, { flag: "wx" }).catch(() => {});

    if (c.openFirewall) {
      const has = await env.run("sh", ["-c", "command -v firewall-cmd"]);
      if (has.code === 0) {
        await ctx.exec("sudo", ["-n", "firewall-cmd", "--permanent", `--add-port=${c.port}/tcp`], { allowFail: true });
        await ctx.exec("sudo", ["-n", "firewall-cmd", "--reload"], { allowFail: true });
      } else {
        ctx.log("No firewalld here, so I left the firewall alone.");
      }
    }
    ctx.log(`Remember: Oracle Cloud needs an ingress rule for TCP ${c.port} (VCN > Security List) before friends can join.`);

    env.saveMeta(c.id, { kind: "minecraft", flavor: c.flavor, version: c.version });
    const heap = `${c.memoryMb}M`;
    return {
      id: c.id,
      name: c.name,
      type: "tmux",
      target: {
        session: `mc-${c.id}`.slice(0, 64),
        startCommand: `${java.bin} -Xms${heap} -Xmx${heap} -jar server.jar nogui`,
        cwd: dir,
        stopCommand: "stop",
        stopTimeoutSec: 60,
        filesRoot: dir,
      },
      note: `Players connect to ${env.publicIp || "<your server IP>"}:${c.port}`,
    };
  },
};
