import os from "node:os";
import path from "node:path";
import { access, rm } from "node:fs/promises";
import { getSetting, setSetting } from "./db.js";

// Claude Code on this machine, so you can sign in from the web terminal and let it build things.
// It's installed into one folder owned by Console's user (no sudo), and that folder is on the terminal's PATH.
export const TOOLS_DIR = process.env.CONSOLE_TOOLS_DIR || path.join(os.homedir(), ".console-tools");
export const toolsBin = (dir = TOOLS_DIR) => path.join(dir, "node_modules", ".bin");

export function createClaudeCode({ db, jobs, run, dir = TOOLS_DIR }) {
  const enabled = () => getSetting(db, "claude_code_enabled", "0") === "1";
  const bin = path.join(toolsBin(dir), "claude");

  async function status() {
    let installed = false;
    try { await access(bin); installed = true; } catch { /* not installed */ }
    let version = null;
    if (installed) {
      const v = await run(bin, ["--version"], { timeout: 15_000 });
      if (v.code === 0) version = v.stdout.trim().split(/\s+/)[0];
    }
    const npm = (await run("npm", ["--version"], { timeout: 10_000 })).code === 0;
    return { enabled: enabled(), installed, version, npm };
  }

  function install(actor) {
    return jobs.start({ title: "Install Claude Code", actor }, async (ctx) => {
      if ((await run("npm", ["--version"], { timeout: 10_000 })).code !== 0) throw new Error("npm isn't installed on this machine, and Claude Code needs it.");
      ctx.log(`Installing into ${dir} (no sudo needed)…`);
      await ctx.exec("npm", ["install", "--prefix", dir, "--no-audit", "--no-fund", "@anthropic-ai/claude-code@latest"]);
      ctx.log("Done. Now use Sign in to open the terminal and log in to your Claude account.");
      return {};
    });
  }

  async function uninstall() {
    await rm(dir, { recursive: true, force: true });
  }

  return { status, install, uninstall, enabled, set: (on) => setSetting(db, "claude_code_enabled", on ? "1" : "0") };
}
