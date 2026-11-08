import { mkdir, writeFile, access, rm } from "node:fs/promises";
import path from "node:path";
import { SetupError, nameAndId, str, commandExists, fail } from "./common.js";
import { parseRepo, validBranch, RepoError } from "../gitutil.js";
import { cloneRepo, installDeps } from "./gitapp.js";

const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SUBDIR = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

export function renderSite(domain, root) {
  return `# Managed by Console (static site). Safe to delete this file to take the site down.\n${domain} {\n    root * ${root}\n    encode gzip\n    file_server\n}\n`;
}

const STARTER = (domain) => `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${domain}</title>\n<style>body{font:18px system-ui;max-width:34rem;margin:20vh auto;padding:0 1rem;color:#222}</style></head>\n<body><h1>${domain} is live 🎉</h1><p>Edit this page in Console: open the site, then the Files tab.</p></body></html>\n`;

const exists = (p) => access(p).then(() => true, () => false);

export default {
  id: "static-site",
  title: "Website",
  blurb: "Put a website on your own domain with automatic HTTPS. Start from a blank page or a GitHub repo.",
  category: "Web",
  level: "simple",
  fields: [
    { key: "domain", label: "Domain", type: "text", required: true, placeholder: "www.example.com", help: "Point this domain's A record at your server's IP first (Cloudflare: DNS only is fine, or proxied)." },
    { key: "source", label: "Start from", type: "select", options: [{ value: "blank", label: "A blank starter page" }, { value: "git", label: "A GitHub repository" }], default: "blank" },
    { key: "repo", label: "GitHub link or owner/repo", type: "text", showWhen: { source: "git" } },
    { key: "branch", label: "Branch", type: "text", level: "standard", showWhen: { source: "git" } },
    { key: "build", label: "It needs a build step (npm run build)", type: "checkbox", level: "standard", showWhen: { source: "git" } },
    { key: "publishDir", label: "Folder to publish", type: "text", level: "standard", showWhen: { source: "git" }, help: "Blank = the whole repo. After a build this is often dist or build." },
    { key: "name", label: "Name", type: "text", level: "standard", help: "Defaults to the domain." },
    { key: "id", label: "ID", type: "text", level: "advanced" },
  ],
  validate(inp, env) {
    const domain = str(inp.domain, 253).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!DOMAIN.test(domain)) throw new SetupError("That doesn't look like a valid domain (example: www.example.com)");
    const git = inp.source === "git";
    let repo = null;
    if (git) {
      try { repo = parseRepo(inp.repo); } catch (e) { if (e instanceof RepoError) throw new SetupError(e.message); throw e; }
    }
    const branch = str(inp.branch, 100);
    if (branch && !validBranch(branch)) throw new SetupError("That branch name isn't allowed");
    const publishDir = str(inp.publishDir, 100).replace(/^\.?\/+|\/+$/g, "");
    if (publishDir && (!SUBDIR.test(publishDir) || publishDir.split("/").includes(".."))) throw new SetupError("Folder to publish must be a simple relative folder like dist");
    const { name, id } = nameAndId({ ...inp, name: str(inp.name, 80) || domain }, env.db, domain);
    return { domain, git, repo, branch, build: git && inp.build === true, publishDir, name, id };
  },
  async run(c, ctx, env) {
    const { sitesDir, sitesRoot } = env.caddy;
    if (!(await commandExists(env.run, "caddy"))) throw fail("Websites need the Caddy web server. Re-run the installer with your Console domain: curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh | sudo bash -s -- --domain console.example.com");
    if (!(await exists(sitesDir))) throw fail(`${sitesDir} doesn't exist. Re-run the Console installer once to prepare it (it's safe to repeat).`);
    const dir = path.join(sitesRoot, c.domain);
    if (await exists(dir)) throw fail(`${dir} already exists. Remove it first or use another domain.`);
    await mkdir(sitesRoot, { recursive: true }).catch(() => {});
    try {
      if (c.git) {
        ctx.log(`Downloading ${c.repo.slug}…`);
        await cloneRepo(ctx, env, c.repo, c.branch, dir);
        if (c.build) {
          await installDeps(dir, "node", { exec: ctx.exec, run: env.run });
          await ctx.exec("npm", ["run", "build"], { cwd: dir });
        }
      } else {
        await mkdir(dir, { recursive: true });
        await writeFile(path.join(dir, "index.html"), STARTER(c.domain));
      }
      const root = c.publishDir ? path.join(dir, c.publishDir) : dir;
      if (!(await exists(root))) throw fail(`The folder "${c.publishDir}" doesn't exist in that repo (after the build, if any).`);
      const file = path.join(sitesDir, `${c.domain}.caddy`);
      await writeFile(file, renderSite(c.domain, root));
      ctx.log("Checking the web server config…");
      const ok = await ctx.exec("sudo", ["-n", "caddy", "validate", "--adapter", "caddyfile", "--config", env.caddy.caddyfile], { allowFail: true });
      if (ok !== 0) {
        await rm(file, { force: true });
        throw fail("The web server didn't like that config, so nothing was changed. See the log above.");
      }
      const reload = await ctx.exec("sudo", ["-n", "systemctl", "reload", "caddy"], { allowFail: true });
      if (reload !== 0) throw fail("Couldn't reload Caddy. Console needs passwordless sudo for that (opc has it on Oracle).");
      env.saveMeta(c.id, { kind: "static", repo: c.repo?.slug ?? null, branch: c.branch || null, dir, build: c.build, domain: c.domain, publishDir: c.publishDir, siteFile: file });
    } catch (e) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
      throw e;
    }
    return {
      id: c.id,
      name: c.name,
      type: "http",
      target: { url: `https://${c.domain}`, filesRoot: dir },
      note: `Make sure ${c.domain} points (A record) at ${env.publicIp || "this server's IP"}. HTTPS turns on by itself once it does, and your Oracle VCN must allow TCP 80 and 443.`,
    };
  },
};
