import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { run as defaultRun } from "./drivers/exec.js";

export class LinuxUserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const NAME = /^[a-z_][a-z0-9_-]{0,31}$/;
const KEY_TYPES = ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com"];
const KEY_LINE = /^([a-z0-9@.-]+) ([A-Za-z0-9+/]{20,4000}={0,2})(?: ([^\x00-\x1f\x7f]{0,100}))?$/;
const RESERVED = new Set(["root", "daemon", "bin", "sys", "nobody", "sshd", "admin", "administrator", "console", "postgres", "mysql", "docker", "caddy"]);

export function parseKey(line) {
  const text = String(line ?? "").trim();
  if (/[\r\n]/.test(text)) throw new LinuxUserError("Paste one key at a time (one line)");
  const m = text.match(KEY_LINE);
  if (!m || !KEY_TYPES.includes(m[1])) throw new LinuxUserError("That doesn't look like a public SSH key. It should start with ssh-ed25519 or ssh-rsa (the .pub file, never the private key).");
  const blob = Buffer.from(m[2], "base64");
  // The key blob starts with its own type name; a mismatch means a mangled or hostile line.
  const len = blob.readUInt32BE(0);
  if (blob.length < 8 || blob.subarray(4, 4 + len).toString() !== m[1]) throw new LinuxUserError("That key looks damaged. Copy the whole line from the .pub file.");
  const fingerprint = "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  return { type: m[1], comment: m[3] ?? "", fingerprint, line: `${m[1]} ${m[2]}${m[3] ? ` ${m[3]}` : ""}` };
}

export function parsePasswd(text) {
  return text.split("\n").filter(Boolean).map((l) => {
    const [name, , uid, gid, , home, shell] = l.split(":");
    return { name, uid: Number(uid), gid: Number(gid), home, shell };
  }).filter((u) => u.name && Number.isInteger(u.uid));
}
export function parseGroups(text) {
  return text.split("\n").filter(Boolean).map((l) => {
    const [name, , gid, members] = l.split(":");
    return { name, gid: Number(gid), members: (members ?? "").split(",").filter(Boolean) };
  });
}

// Manages Linux accounts with `sudo -n` (so it needs passwordless sudo, which `opc` has on Oracle). Every argument is
// validated and passed as its own argv entry. There is no shell string built from user input anywhere in here.
export function createLinuxUsers({ run = defaultRun, passwdFile = "/etc/passwd", groupFile = "/etc/group", selfUser, minUid = 1000 } = {}) {
  const read = () => ({ users: parsePasswd(readFileSync(passwdFile, "utf8")), groups: parseGroups(readFileSync(groupFile, "utf8")) });
  const sudoGroupName = (groups) => (groups.find((g) => g.name === "wheel") ? "wheel" : groups.find((g) => g.name === "sudo") ? "sudo" : null);
  const human = (u) => u.uid >= minUid && u.uid < 60000 && u.name !== "nobody";

  async function sudo(args, opts) {
    const r = await run("sudo", ["-n", ...args], { timeout: 30_000, ...opts });
    if (r.code !== 0) {
      if (/a password is required|no tty present|not in the sudoers/i.test(r.stderr)) throw new LinuxUserError("Console's user doesn't have passwordless sudo, so it can't do this.", 403);
      throw new LinuxUserError(r.stderr.trim().split("\n").pop() || "That didn't work", 500);
    }
    return r.stdout;
  }

  function need(name, { allowSelf = true } = {}) {
    if (typeof name !== "string" || !NAME.test(name)) throw new LinuxUserError("That isn't a valid user name");
    const { users, groups } = read();
    const u = users.find((x) => x.name === name);
    if (!u) throw new LinuxUserError("No such user", 404);
    if (!human(u)) throw new LinuxUserError("System accounts can't be changed from here");
    if (!allowSelf && name === selfUser) throw new LinuxUserError(`"${name}" is the account Console itself runs as, so this would lock Console out.`);
    return { u, groups, users };
  }

  function list() {
    const { users, groups } = read();
    const sg = sudoGroupName(groups);
    return {
      self: selfUser,
      sudoGroup: sg,
      users: users.filter(human).map((u) => ({
        name: u.name, uid: u.uid, home: u.home, shell: u.shell, self: u.name === selfUser,
        sudo: sg ? groups.find((g) => g.name === sg).members.includes(u.name) : false,
        canLogin: !/(nologin|false)$/.test(u.shell),
      })),
    };
  }

  async function keys(name) {
    const { u } = need(name);
    const r = await run("sudo", ["-n", "-u", name, "-H", "cat", `${u.home}/.ssh/authorized_keys`], { timeout: 10_000 });
    if (r.code !== 0) return /No such file/i.test(r.stderr) ? [] : (() => { throw new LinuxUserError("Couldn't read that user's keys", 500); })();
    return r.stdout.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
      try { const k = parseKey(l); return { type: k.type, comment: k.comment, fingerprint: k.fingerprint }; } catch { return { type: "other", comment: "(line with options or an unusual format)", fingerprint: null }; }
    });
  }

  async function addKey(name, keyText) {
    need(name);
    const key = parseKey(keyText);
    const have = (await keys(name)).some((k) => k.fingerprint === key.fingerprint);
    if (have) throw new LinuxUserError("That key is already on this account");
    await sudo(["-u", name, "-H", "sh", "-c", 'umask 077; mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh" && cat >> "$HOME/.ssh/authorized_keys" && chmod 600 "$HOME/.ssh/authorized_keys"'], { input: key.line + "\n" });
    return key.fingerprint;
  }

  async function removeKey(name, fingerprint) {
    const { u } = need(name);
    if (typeof fingerprint !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint)) throw new LinuxUserError("Bad key fingerprint");
    const r = await run("sudo", ["-n", "-u", name, "-H", "cat", `${u.home}/.ssh/authorized_keys`], { timeout: 10_000 });
    if (r.code !== 0) throw new LinuxUserError("That user has no keys file", 404);
    let removed = 0;
    const kept = r.stdout.split("\n").filter((line) => {
      try { if (parseKey(line.trim()).fingerprint === fingerprint) return (removed++, false); } catch { /* keep anything we don't understand */ }
      return true;
    });
    if (!removed) throw new LinuxUserError("That key isn't on this account", 404);
    await sudo(["-u", name, "-H", "sh", "-c", 'cat > "$HOME/.ssh/authorized_keys"'], { input: kept.join("\n").replace(/\n*$/, "\n") });
    return removed;
  }

  async function create({ name, sudo: wantSudo, key }) {
    if (typeof name !== "string" || !NAME.test(name)) throw new LinuxUserError("User names use lowercase letters, numbers, - and _, starting with a letter");
    if (RESERVED.has(name)) throw new LinuxUserError(`"${name}" is a reserved name`);
    const { users, groups } = read();
    if (users.some((u) => u.name === name)) throw new LinuxUserError(`"${name}" already exists`, 409);
    const sg = sudoGroupName(groups);
    if (wantSudo && !sg) throw new LinuxUserError("This system has no sudo or wheel group");
    const parsed = key ? parseKey(key) : null; // validate before changing anything
    await sudo(["useradd", "-m", "-s", "/bin/bash", name]);
    if (wantSudo) await sudo(["usermod", "-aG", sg, name]);
    if (parsed) await addKey(name, parsed.line);
    return { name };
  }

  async function setSudo(name, on) {
    const { groups } = need(name, { allowSelf: on === true });
    const sg = sudoGroupName(groups);
    if (!sg) throw new LinuxUserError("This system has no sudo or wheel group");
    if (on) await sudo(["usermod", "-aG", sg, name]);
    else await sudo(["gpasswd", "-d", name, sg]);
  }

  async function remove(name, { deleteHome = false, confirm } = {}) {
    need(name, { allowSelf: false });
    if (confirm !== name) throw new LinuxUserError("Type the user's name to confirm");
    await sudo(["userdel", ...(deleteHome ? ["-r"] : []), name]);
  }

  return { list, keys, addKey, removeKey, create, setSudo, remove };
}
