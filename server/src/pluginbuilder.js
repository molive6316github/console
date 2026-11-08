import path from "node:path";
import { mkdir, readdir, readFile, writeFile, cp, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { readManifest, PluginError } from "./cplugins.js";
import { toolsBin } from "./claudecode.js";

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "plugin";

// "Describe it" → Claude Code (signed in on this machine) writes a draft plugin into its own folder. Nothing runs until you review and install it.
export function createPluginBuilder({ dataDir, jobs, claude, host, repoRoot, userDir = host.userDir, run, claudeBin = null }) {
  const draftsDir = path.join(dataDir, "plugin-drafts");

  async function start(prompt, actor) {
    const text = String(prompt ?? "").trim();
    if (text.length < 10 || text.length > 2000) throw new PluginError("Describe what you want in 10 to 2000 characters");
    const st = await claude.status();
    if (!st.enabled || !st.installed) throw new PluginError("Turn on Claude Code first (Panel settings → Claude Code), install it, and sign in once in the terminal.");
    const id = `${slug(text.split(/\s+/).slice(0, 4).join(" "))}-${Date.now().toString(36).slice(-4)}`;
    const dir = path.join(draftsDir, id);
    await mkdir(dir, { recursive: true });
    await cp(path.join(repoRoot, "PLUGINS.md"), path.join(dir, "CLAUDE.md"));
    await mkdir(path.join(dir, "examples"), { recursive: true });
    for (const ex of ["announcer", "public-api"]) if (existsSync(path.join(repoRoot, "server", "plugins", ex))) await cp(path.join(repoRoot, "server", "plugins", ex), path.join(dir, "examples", ex), { recursive: true });
    await writeFile(path.join(dir, "REQUEST.txt"), text + "\n");
    const task = `Read CLAUDE.md, then build a Console plugin for this request (also saved in REQUEST.txt):\n\n${text}\n\nWrite manifest.json (use the id "${id}") and index.js in the current folder. Follow CLAUDE.md exactly. Use only Node built-in modules and the ctx object. Keep it small and readable. When finished, reply with two sentences describing what it does and which settings to fill in.`;
    const job = jobs.start({ title: "Claude is writing your plugin", actor }, async (ctx) => {
      ctx.log(`Draft folder: ${dir}`);
      const bin = claudeBin ?? path.join(toolsBin(), "claude");
      // Read/Write/Edit only: no shell, so it can't run anything while drafting.
      await ctx.exec(bin, ["-p", task, "--allowedTools", "Read", "Write", "Edit", "--permission-mode", "acceptEdits", "--max-turns", "30"], { cwd: dir, env: { PATH: `${toolsBin()}:${process.env.PATH}` }, label: "claude -p (writing the plugin)" });
      const m = readManifest(dir, false);
      if (!m || m.error) throw new Error(m?.error ?? "Claude didn't produce a manifest.json. Try describing it differently.");
      if (!existsSync(path.join(dir, m.entry))) throw new Error(`Claude didn't produce ${m.entry}.`);
      ctx.log("Draft is ready. Review it on the Plugins page, then install it.");
      return { draft: id };
    });
    return { jobId: job.id, draft: id };
  }

  async function drafts() {
    if (!existsSync(draftsDir)) return [];
    const out = [];
    for (const id of await readdir(draftsDir)) {
      const dir = path.join(draftsDir, id);
      if (!(await stat(dir)).isDirectory()) continue;
      const m = readManifest(dir, false);
      const request = (await readFile(path.join(dir, "REQUEST.txt"), "utf8").catch(() => "")).trim();
      out.push({ id, request, name: m?.name ?? id, description: m?.description ?? "", ready: Boolean(m && !m.error && existsSync(path.join(dir, m.entry ?? "index.js"))), error: m?.error ?? null, pluginId: m?.id ?? null });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  const draftDir = (id) => {
    if (!/^[a-z0-9-]{3,60}$/.test(id)) throw new PluginError("Bad draft", 404);
    const d = path.join(draftsDir, id);
    if (!existsSync(d)) throw new PluginError("No such draft", 404);
    return d;
  };

  async function files(id) {
    const dir = draftDir(id);
    const m = readManifest(dir, false);
    const out = {};
    for (const f of ["manifest.json", m?.entry ?? "index.js"]) out[f] = await readFile(path.join(dir, f), "utf8").catch(() => "");
    return out;
  }

  // Copies the draft into the plugins folder. It stays OFF until you switch it on.
  async function install(id) {
    const dir = draftDir(id);
    const m = readManifest(dir, false);
    if (!m || m.error) throw new PluginError(m?.error ?? "The draft has no manifest.json");
    if (host.discover().get(m.id)?.builtin) throw new PluginError("That id belongs to a built-in plugin. Ask Claude to pick another.");
    const dest = path.join(userDir, m.id);
    await mkdir(userDir, { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await cp(path.join(dir, "manifest.json"), path.join(dest, "manifest.json"));
    await cp(path.join(dir, m.entry), path.join(dest, m.entry));
    for (const extra of await readdir(dir)) if (/^[\w.-]+\.(js|css|html|json|txt|md)$/.test(extra) && !["manifest.json", m.entry, "CLAUDE.md", "REQUEST.txt"].includes(extra)) await cp(path.join(dir, extra), path.join(dest, extra));
    return { id: m.id };
  }

  async function discard(id) { await rm(draftDir(id), { recursive: true, force: true }); }

  void run;
  return { start, drafts, files, install, discard };
}
