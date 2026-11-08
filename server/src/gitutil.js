// Turning what a person types ("me/my-bot", a GitHub link) into a safe https clone URL.
const HOSTS = new Set(["github.com", "gitlab.com", "codeberg.org"]);
const SEG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

export class RepoError extends Error {
  userFacing = true;
}

export function parseRepo(input) {
  let s = String(input ?? "").trim();
  if (!s) throw new RepoError("Paste a GitHub link, or owner/repo");
  let host = "github.com";
  const ssh = s.match(/^git@([^:]+):(.+)$/);
  if (ssh) s = `https://${ssh[1]}/${ssh[2]}`;
  if (/^[a-z]+:\/\//i.test(s)) {
    let u;
    try { u = new URL(s); } catch { throw new RepoError("That doesn't look like a valid link"); }
    if (u.protocol !== "https:") throw new RepoError("Use an https:// link");
    if (u.username || u.password) throw new RepoError("Don't put a password or token in the link. Save a token in Settings instead.");
    host = u.hostname.toLowerCase();
    s = u.pathname.replace(/^\/+/, "");
  } else if (/^(github\.com|gitlab\.com|codeberg\.org)\//i.test(s)) {
    host = s.split("/")[0].toLowerCase();
    s = s.slice(host.length + 1);
  }
  if (!HOSTS.has(host)) throw new RepoError(`Only ${[...HOSTS].join(", ")} are supported`);
  const parts = s.replace(/\.git$/, "").replace(/\/+$/, "").split("/");
  if (parts.length < 2) throw new RepoError("Use the form owner/repo");
  const [owner, repo] = parts;
  if (!SEG.test(owner) || !SEG.test(repo)) throw new RepoError("That owner/repo has characters that aren't allowed");
  if (owner.includes("..") || repo.includes("..")) throw new RepoError("That owner/repo isn't allowed");
  return { host, owner, repo, url: `https://${host}/${owner}/${repo}.git`, slug: `${owner}/${repo}` };
}

export function validBranch(b) {
  return typeof b === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(b) && !b.includes("..");
}

// The token goes in through git's environment config, so it never lands in the command line, `ps`, or .git/config.
export function gitEnv(token, host = "github.com") {
  const env = { GIT_TERMINAL_PROMPT: "0" };
  if (token && host === "github.com") {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    Object.assign(env, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
    });
  }
  return env;
}
export const tokenSecrets = (token) => (token ? [token, Buffer.from(`x-access-token:${token}`).toString("base64")] : []);
