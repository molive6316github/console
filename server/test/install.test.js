import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Loads install.sh without running it, then runs a snippet that uses its functions.
function sh(snippet, env = {}) {
  const r = spawnSync("bash", ["-c", `CONSOLE_INSTALL_SOURCE_ONLY=1 source ./install.sh\n${snippet}`], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function envFile(initial = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "console-inst-"));
  const file = path.join(dir, "console.env");
  writeFileSync(file, initial);
  return { dir, file, read: () => readFileSync(file, "utf8") };
}

test("domains are normalised and strictly validated (they end up in a Caddyfile)", () => {
  assert.equal(sh(String.raw`normalize_domain 'HTTPS://Console.MXT.Productions/some/path'`).out, "console.mxt.productions");
  const good = ["console.mxt.productions", "a.co", "x-y.example.com", "mxt.bio"];
  const bad = ["localhost", "has space.com", "evil.com}", "-bad.com", "a..com", "x.com;rm", "1.2.3.4", "foo.c", "a.com\nb.com"];
  const probe = (list) =>
    sh(`for d in ${list.map((d) => `$'${d.replace(/\n/g, "\\n")}'`).join(" ")}; do if valid_domain "$d"; then echo yes; else echo no; fi; done`)
      .out.trim().split("\n");
  assert.deepEqual(probe(good), good.map(() => "yes"));
  assert.deepEqual(probe(bad), bad.map(() => "no"));
});

test("env_set adds and replaces, keeps everything else, and survives nasty values", () => {
  const e = envFile("# a comment\nKEEP=me\nTRICKY=old\n");
  const nasty = String.raw`a&b\c/d|e=f g`;
  const r = sh(String.raw`env_set TRICKY 'a&b\c/d|e=f g'; env_set NEWKEY 1; env_get TRICKY`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.replace(/\n$/, ""), nasty);
  const text = e.read();
  assert.match(text, /^# a comment$/m);
  assert.match(text, /^KEEP=me$/m);
  assert.match(text, /^NEWKEY=1$/m);
  assert.equal(text.split("\n").filter((l) => l.startsWith("TRICKY=")).length, 1);
  assert.equal(statSync(e.file).mode & 0o777, 0o600);
});

test("env_del removes only that key, env_default never overwrites", () => {
  const e = envFile("A=1\nB=2\nAB=3\n");
  sh(`env_del A; env_default B 99; env_default C 7`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(e.read(), "B=2\nAB=3\nC=7\n");
});

test("write_env: domain mode is loopback + secure cookies + proxy trust, and remembers the domain", () => {
  const e = envFile("EXTRA=keepme\nCONSOLE_ADMIN_USER=boss\n");
  const r = sh(`DOMAIN=console.example.com; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(r.code, 0, r.err);
  const t = e.read();
  for (const line of ["HOST=127.0.0.1", "CONSOLE_SECURE_COOKIES=1", "CONSOLE_TRUST_PROXY=1", "CONSOLE_DOMAIN=console.example.com", "PORT=3000", "CONSOLE_DB=/opt/console/data/console.db", "EXTRA=keepme", "CONSOLE_ADMIN_USER=boss"]) {
    assert.ok(t.split("\n").includes(line), `missing ${line}`);
  }
});

test("write_env: switching to IP mode removes secure cookies (they'd break plain-HTTP login)", () => {
  const e = envFile("");
  sh(`DOMAIN=console.example.com; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  sh(`DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  const lines = e.read().split("\n");
  assert.ok(lines.includes("HOST=0.0.0.0"));
  assert.equal(lines.some((l) => /^(CONSOLE_SECURE_COOKIES|CONSOLE_TRUST_PROXY|CONSOLE_DOMAIN)=/.test(l)), false);
});

test("write_env: a non-main branch is recorded for the dashboard updater, main clears it", () => {
  const e = envFile("");
  sh(`DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=dev; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.ok(e.read().includes("CONSOLE_UPDATE_BRANCH=dev"));
  sh(`DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(e.read().includes("CONSOLE_UPDATE_BRANCH"), false);
});

test("render_caddyfile proxies the domain to Console on loopback", () => {
  const out = sh(`render_caddyfile console.example.com 3000`).out;
  assert.match(out, /^console\.example\.com \{$/m);
  assert.match(out, /reverse_proxy 127\.0\.0\.1:3000/);
});

test("render_unit keeps the restart behaviour the updater relies on and swaps in real paths", () => {
  const out = sh(`render_unit /usr/local/bin/node ${root} /etc/console.env`).out;
  assert.match(out, /^ExecStart=\/usr\/local\/bin\/node server\/src\/index\.js$/m);
  assert.match(out, new RegExp(`^WorkingDirectory=${root.replace(/[/.]/g, "\\$&")}$`, "m"));
  assert.match(out, /^EnvironmentFile=\/etc\/console\.env$/m);
  assert.match(out, /^Restart=on-failure$/m);
  assert.match(out, /^KillMode=process$/m);
  assert.match(out, /^User=console$/m);
  assert.match(out, /^NoNewPrivileges=true$/m);
});

test("render_unit for a login user like opc drops NoNewPrivileges so sudo works", () => {
  const out = sh(`render_unit /usr/bin/node ${root} /etc/console.env opc`).out;
  assert.match(out, /^User=opc$/m);
  assert.doesNotMatch(out, /NoNewPrivileges/);
  assert.match(out, /^KillMode=process$/m);
});

test("pick_user: flag beats saved beats sudo caller beats console; bad names are refused", () => {
  const e = envFile("CONSOLE_RUN_USER=saveduser\n");
  const pick = (pre, extra = {}) => sh(`${pre}; pick_user; echo "$SVC_USER"`, { CONSOLE_ENV_FILE: e.file, ...extra }).out.trim();
  assert.equal(pick(`USER_FLAG=flaguser`), "flaguser");
  assert.equal(pick(`USER_FLAG=""`), "saveduser");
  const e2 = envFile("");
  const pick2 = (extra) => sh(`USER_FLAG=""; pick_user; echo "$SVC_USER"`, { CONSOLE_ENV_FILE: e2.file, ...extra }).out.trim();
  assert.equal(pick2({ SUDO_USER: "root" }), "console");
  assert.equal(pick2({ SUDO_USER: "" }), "console");
  assert.equal(sh(`valid_username 'a b'`).code === 0, false);
  assert.equal(sh(`valid_username 'root'`).code === 0, false);
  assert.equal(sh(`valid_username 'opc'`).code, 0);
});

test("parse_args accepts good input", () => {
  const r = sh(`parse_args --domain Foo.Example.com --port 8080 --branch dev --dir /srv/c --yes; echo "$DOMAIN $PORT_FLAG $BRANCH $DIR $ASSUME_YES"`);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "foo.example.com 8080 dev /srv/c 1");
});

test("parse_args rejects anything suspicious", () => {
  for (const args of [
    `--domain 'bad domain'`,
    `--domain 'x.com}'`,
    `--port 99999`,
    `--port abc`,
    `--bogus`,
    `--dir relative/path`,
    `--dir '/x; rm -rf /'`,
    `--branch '--upload-pack=evil'`,
    `--domain`,
  ]) {
    const r = sh(`parse_args ${args}`);
    assert.notEqual(r.code, 0, `should reject: ${args}`);
  }
});

test("prepare_admin: generates a password on first run, never on an existing install, rejects weak presets", () => {
  const e = envFile("");
  const db = path.join(e.dir, "console.db");
  writeFileSync(e.file, `CONSOLE_DB=${db}\n`);

  const first = sh(`ADMIN_PW_PRESET=""; prepare_admin; echo "$ADMIN_PW_NOTE:$ADMIN_PW"`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(first.code, 0, first.err);
  const [note, pw] = first.out.trim().split(":");
  assert.equal(note, "generated");
  assert.match(pw, /^[A-Za-z0-9_-]{20}$/);
  assert.ok(e.read().includes(`CONSOLE_ADMIN_PASSWORD=${pw}`));

  writeFileSync(db, "");
  writeFileSync(e.file, `CONSOLE_DB=${db}\n`);
  const existing = sh(`ADMIN_PW_PRESET=""; prepare_admin; echo "$ADMIN_PW_NOTE"`, { CONSOLE_ENV_FILE: e.file });
  assert.equal(existing.out.trim(), "existing");
  assert.equal(e.read().includes("CONSOLE_ADMIN_PASSWORD"), false);

  const weak = sh(`ADMIN_PW_PRESET='short'; prepare_admin`, { CONSOLE_ENV_FILE: envFile(`CONSOLE_DB=${path.join(e.dir, "nope.db")}\n`).file });
  assert.notEqual(weak.code, 0);
});

test("the installer refuses politely when it can't work (no root or no systemd) and --help works", () => {
  const help = spawnSync("bash", ["install.sh", "--help"], { cwd: root, encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--domain NAME/);
  const run = spawnSync("bash", ["install.sh", "--yes"], { cwd: root, encoding: "utf8", env: { ...process.env, CONSOLE_DOMAIN: "" } });
  if (!spawnSync("test", ["-d", "/run/systemd/system"]).status) return; // real systemd machine: don't run an install from a test
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Run this as root|systemd/);
});

test("main is the last thing in the script (it is read piped from curl, so nothing may follow it)", () => {
  const lines = readFileSync(path.join(root, "install.sh"), "utf8").trimEnd().split("\n");
  assert.deepEqual(lines.slice(-3), ['if [ "${CONSOLE_INSTALL_SOURCE_ONLY:-0}" != 1 ]; then', '  main "$@"', "fi"]);
});

test("--minecraft is remembered in the env file and --standard turns it off", () => {
  const e = envFile("");
  sh(`MODE_FLAG=minecraft; DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.match(e.read(), /^CONSOLE_MODE=minecraft$/m);
  sh(`MODE_FLAG=""; DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.match(e.read(), /^CONSOLE_MODE=minecraft$/m); // untouched when no flag is given
  sh(`MODE_FLAG=standard; DOMAIN=""; PORT=3000; DIR=/opt/console; BRANCH=main; write_env`, { CONSOLE_ENV_FILE: e.file });
  assert.doesNotMatch(e.read(), /CONSOLE_MODE/);
  assert.equal(sh(`parse_args --minecraft --yes; echo $MODE_FLAG`).out.trim(), "minecraft");
});

// ---- the setup wizard ---------------------------------------------------------------------
test("wizard validators accept good input and refuse anything odd", () => {
  const t = (fn, v) => sh(`${fn} '${v}' && echo yes || echo no`).out.trim();
  assert.equal(t("valid_password", "correct-horse_42"), "yes");
  assert.equal(t("valid_password", "short"), "no");
  assert.equal(t("valid_password", "has space in it!!"), "no");
  assert.equal(t("valid_org", "MyTeam"), "yes");
  assert.equal(t("valid_org", "-bad"), "no");
  assert.equal(t("valid_org", "a/b"), "no");
  assert.equal(t("valid_hook", "https://discord.com/api/webhooks/1/abc"), "yes");
  assert.equal(t("valid_hook", "http://discord.com/x"), "no");
  assert.equal(t("valid_hook", "https://x.com/a b"), "no");
  assert.equal(t("valid_tz", "America/New_York"), "yes");
  assert.equal(t("valid_tz", "Nowhere/Land"), "no");
  assert.equal(t("valid_tz", "../../etc/passwd"), "no");
  assert.equal(t("valid_token", "ghp_" + "a".repeat(36)), "yes");
  assert.equal(t("valid_token", "short"), "no");
  assert.equal(t("valid_token", "ghp_ has space aaaaaaaaaaaaaaaa"), "no");
  assert.equal(sh(`mask_tail ghp_abcdef123456`).out, "••••3456");
});

// Answers are fed in order to the wizard's questions, so the whole conversation can be tested without a terminal.
const scripted = (answers) => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), "console-ans-")), "answers");
  writeFileSync(f, answers.join("\n") + "\n");
  // ask runs inside $(...), so the queue lives in a file rather than a variable
  return String.raw`
pop() { local a; a=$(head -n1 "ANSFILE"); sed -i 1d "ANSFILE"; printf '%s' "$a"; }
ask()        { printf '%s' "$1" >&2; pop; }
ask_secret() { printf '%s' "$1" >&2; pop; }
`.replaceAll("ANSFILE", f);
};

test("wizard, first install: collects every answer and writes them for Console to apply once", () => {
  const e = envFile();
  const tok = "ghp_" + "a1".repeat(18);
  const r = sh(
    scripted([
      "1", // Minecraft host
      "maxo", // username
      "n", // make my own password
      "My-long-pass_99", "My-long-pass_99",
      "y", // change technical settings
      "25570", // port
      tok, // github token
      "MyTeam", // org
      "UTC", // time zone
      "14", // keep
      "https://discord.com/api/webhooks/1/abc", // webhook
      "y", // terminal
      "n", // linux users
      "y", // go
    ]) + `
HAVE_TTY=1; DIR=/nonexistent-dir; PUBLIC_IP=203.0.113.9
wizard
write_wizard_env
echo "MODE=$MODE_FLAG PORT=$PORT PW_SET=$([ -n "$ADMIN_PW_PRESET" ] && echo y)"
`,
    { CONSOLE_ENV_FILE: e.file, CONSOLE_DB: "/nonexistent-dir/data/console.db" }
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /MODE=minecraft PORT=25570 PW_SET=y/);
  const env = e.read();
  assert.match(env, /^CONSOLE_ADMIN_USER=maxo$/m);
  assert.match(env, new RegExp(`^CONSOLE_GITHUB_TOKEN=${tok}$`, "m"));
  assert.match(env, /^CONSOLE_GITHUB_ORG=MyTeam$/m);
  assert.match(env, /^CONSOLE_TIMEZONE=UTC$/m);
  assert.match(env, /^CONSOLE_BACKUP_KEEP=14$/m);
  assert.match(env, /^CONSOLE_ALERT_WEBHOOK=https:\/\/discord\.com\/api\/webhooks\/1\/abc$/m);
  assert.match(env, /^CONSOLE_ENABLE_TERMINAL=1$/m);
  assert.doesNotMatch(env, /LINUX_USERS/);
  assert.doesNotMatch(r.out, new RegExp(tok), "the token is never echoed in full");
  assert.match(r.out, /••••/);
});

test("wizard: bad answers are rejected with a warning instead of being saved, and 'no' at the end changes nothing", () => {
  const e = envFile();
  const r = sh(
    scripted(["2", "root", "y", "", "not a token", "n", "Nowhere/Land", "999", "http://insecure", "n", "n", "n"]) + `
HAVE_TTY=1; DIR=/nonexistent-dir
( wizard ) && rc=0 || rc=$?; echo "wizard-exit=$rc"
write_wizard_env
`,
    { CONSOLE_ENV_FILE: e.file, CONSOLE_DB: "/nonexistent-dir/data/console.db" }
  );
  assert.match(r.out, /wizard-exit=1/, "answering no at the final question cancels");
  assert.match(r.err, /Cancelled/);
  assert.equal(e.read(), "", "nothing was written");
  assert.match(r.err, /doesn't look like a GitHub token/);
  assert.match(r.err, /Unknown time zone/);
  assert.match(r.err, /https:\/\/ URL/);
  assert.match(r.err, /Using 'admin'/);
});

test("wizard on an existing install only asks about mode and address, and never touches the admin", () => {
  const e = envFile("PORT=3000\nCONSOLE_DB=/tmp/exists.db\n");
  writeFileSync("/tmp/exists.db", "");
  const r = sh(
    scripted(["1", "", "y"]) + `
HAVE_TTY=1
wizard
write_wizard_env
echo "ADMIN=$WIZ_ADMIN_USER MODE=$MODE_FLAG"
`,
    { CONSOLE_ENV_FILE: e.file }
  );
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\[2\/2\]/);
  assert.match(r.out, /ADMIN= MODE=minecraft/);
  assert.doesNotMatch(e.read(), /GITHUB|ADMIN_USER/);
});

test("clear_wizard_env removes the one-time keys but keeps real settings", () => {
  const e = envFile("PORT=3000\nCONSOLE_GITHUB_TOKEN=x\nCONSOLE_TIMEZONE=UTC\nCONSOLE_ENABLE_TERMINAL=1\nCONSOLE_MODE=minecraft\n");
  sh("clear_wizard_env", { CONSOLE_ENV_FILE: e.file });
  assert.equal(e.read(), "PORT=3000\nCONSOLE_MODE=minecraft\n");
});

test("spin shows success quietly and prints the command's output only when it fails", () => {
  const ok = sh(`spin "Doing a thing" bash -c 'echo SECRETNOISE'`);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /Doing a thing/);
  assert.doesNotMatch(ok.out + ok.err, /SECRETNOISE/);
  const bad = sh(`spin "Doing a thing" bash -c 'echo BOOM-DETAIL; exit 3' || echo "rc=$?"`);
  assert.match(bad.out, /rc=3/);
  assert.match(bad.err, /BOOM-DETAIL/);
});

test("Minecraft mode is detected from the flag or the saved mode, and --standard wins", () => {
  const e = envFile("CONSOLE_MODE=minecraft\n");
  const t = (flag) => sh(`MODE_FLAG='${flag}'; is_mc_mode && echo yes || echo no`, { CONSOLE_ENV_FILE: e.file }).out.trim();
  assert.equal(t(""), "yes");
  assert.equal(t("standard"), "no");
  assert.equal(t("minecraft"), "yes");
  assert.equal(sh(`MODE_FLAG=''; is_mc_mode && echo yes || echo no`, { CONSOLE_ENV_FILE: envFile().file }).out.trim(), "no");
});


// ---- Docker instances (a fake `docker` records what it was asked to do) ----------------------
import { mkdirSync, chmodSync, existsSync as exists } from "node:fs";
import http from "node:http";

function fakeDocker() {
  const dir = mkdtempSync(path.join(tmpdir(), "console-fakedocker-"));
  const log = path.join(dir, "calls.log");
  writeFileSync(path.join(dir, "docker"), `#!/bin/bash
printf '%s\\n' "$*" >> "${log}"
case "$1" in
  info) exit 0 ;;
  ps) exit 0 ;;
  inspect) exit 0 ;;
  *) exit 0 ;;
esac
`);
  chmodSync(path.join(dir, "docker"), 0o755);
  return { bin: dir, calls: () => (exists(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

test("valid_instance / valid_ports / valid_limit guard what ends up on a docker command line", () => {
  const t = (fn, v) => sh(`${fn} '${v}' && echo yes || echo no`).out.trim();
  assert.equal(t("valid_instance", "mc-test_1"), "yes");
  for (const bad of ["", "Upper", "-x", "a b", "a/b", "../x", "a".repeat(40)]) assert.equal(t("valid_instance", bad), "no", bad);
  assert.equal(t("valid_ports", "25565,8080"), "yes");
  assert.equal(t("valid_ports", "none"), "yes");
  for (const bad of ["", "0", "70000", "25565;rm", "a", "1,,2"]) assert.equal(t("valid_ports", bad), "no", bad);
  assert.equal(t("valid_limit", "4g"), "yes");
  assert.equal(t("valid_limit", "1.5"), "yes");
  assert.equal(t("valid_limit", "4g --privileged"), "no");
});

test("docker run arguments: hardened, own volume, loopback-only when asked, no host mounts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-dock-"));
  const r = sh(
    `d_denv_set t1 CONSOLE_D_PORT 3101; d_denv_set t1 CONSOLE_D_PORTS 25565,8080; d_denv_set t1 CONSOLE_D_PUBLIC 1; d_denv_set t1 CONSOLE_D_MEM 4g; d_denv_set t1 CONSOLE_D_CPUS 2
docker_run_args t1 | tr '\\n' ' '; echo
d_denv_set t2 CONSOLE_D_PORT 3102; d_denv_set t2 CONSOLE_D_PORTS none; d_denv_set t2 CONSOLE_D_PUBLIC 0
docker_run_args t2 | tr '\\n' ' '`,
    { CONSOLE_DOCKER_ENV_DIR: dir }
  );
  const [a, b] = r.out.trim().split("\n");
  assert.match(a, /run -d --init --name console-t1 --label console.instance=t1 --restart unless-stopped/);
  assert.match(a, /-v console-t1-data:\/data/);
  assert.match(a, /-p 0\.0\.0\.0:3101:3000/);
  assert.match(a, /-p 0\.0\.0\.0:25565:25565 -p 0\.0\.0\.0:8080:8080/);
  assert.match(a, /--cap-drop ALL --security-opt no-new-privileges/);
  assert.match(a, /--memory 4g --cpus 2 console:local $/);
  assert.match(b, /-p 127\.0\.0\.1:3102:3000/);
  assert.doesNotMatch(b, /25565|--memory/);
  for (const line of [a, b]) {
    assert.doesNotMatch(line, /--privileged|docker\.sock|--pid[ =]|--network host|-v \//, "never mounts the host or shares its namespaces");
  }
});

test("docker instance end to end (fake docker): builds, writes a private env file, starts, scrubs one-time secrets, updating keeps data", async () => {
  const fd = fakeDocker();
  const envDir = mkdtempSync(path.join(tmpdir(), "console-denv-"));
  const repo = mkdtempSync(path.join(tmpdir(), "console-drepo-"));
  mkdirSync(path.join(repo, "deploy"));
  writeFileSync(path.join(repo, "deploy", "Dockerfile"), "FROM scratch\n");
  for (const c of [["init", "-q", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "x"]]) spawnSync("git", c, { cwd: repo });
  // pretend container: answers on a port
  const srv = http.createServer((_q, res) => res.end("{}"));
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const env = {
    PATH: `${fd.bin}:${process.env.PATH}`, CONSOLE_DOCKER_ENV_DIR: envDir, CONSOLE_DOCKER_SRC: path.join(mkdtempSync(path.join(tmpdir(), "console-dsrc-")), "src"),
    CONSOLE_REPO: repo, CONSOLE_DOCKER_PORT: String(port), CONSOLE_DOCKER_PORTS: "25565", CONSOLE_DOCKER_PUBLIC: "0", CONSOLE_ADMIN_PASSWORD: "Sup3r-long_pass",
  };
  const snippet = (name) => `open_ports() { echo "OPEN $*"; }; MODE_FLAG=minecraft; ADMIN_PW_PRESET="$CONSOLE_ADMIN_PASSWORD"; unset CONSOLE_ADMIN_PASSWORD; HAVE_TTY=0; DOCKER_NAME=${name}; PUBLIC_IP=203.0.113.5; docker_main`;
  // async spawn: the fake "container" HTTP server lives in this process and must keep answering
  const run = (name) => new Promise((resolve) => {
    const c = spawn("bash", ["-c", `CONSOLE_INSTALL_SOURCE_ONLY=1 source ./install.sh\n${snippet(name)}`], { cwd: root, env: { ...process.env, ...env } });
    let stdout = "", stderr = "";
    c.stdout.on("data", (d) => (stdout += d));
    c.stderr.on("data", (d) => (stderr += d));
    c.on("close", (status) => resolve({ status, stdout, stderr }));
  });
  const r1 = run("t1");
  const p1 = await r1;
  srv.close();
  assert.equal(p1.status, 0, p1.stderr + p1.stdout);
  const calls = fd.calls();
  assert.ok(calls.some((c) => c.startsWith("build -q -f") && c.includes(" -t console:local ")), calls.join("\n"));
  const runs = calls.filter((c) => c.startsWith("run -d"));
  assert.equal(runs.length, 2, "started once, recreated once to scrub the one-time secrets");
  assert.match(runs[0], /-v console-t1-data:\/data/);
  assert.match(runs[0], /-p 127\.0\.0\.1:\d+:3000 -.*-p 127\.0\.0\.1:25565:25565/);
  const file = path.join(envDir, "t1.env");
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  const saved = readFileSync(file, "utf8");
  assert.match(saved, /^CONSOLE_MODE=minecraft$/m);
  assert.match(saved, /^HOST=0\.0\.0\.0$/m);
  assert.doesNotMatch(saved, /Sup3r-long_pass|CONSOLE_ADMIN_PASSWORD/, "first-run password removed after start");
  assert.match(p1.stdout, /Docker instance 't1' is running/);
  assert.match(p1.stdout, /Sign in:\s+admin\s+\/\s+the password you set/);
  assert.doesNotMatch(p1.stdout + p1.stderr, /Sup3r-long_pass/);

  // Updating the same name keeps its settings and does not ask for or reset anything.
  const srv2 = http.createServer((_q, res) => res.end("{}"));
  await new Promise((r) => srv2.listen(port, "127.0.0.1", r));
  const p2 = await run("t1");
  srv2.close();
  assert.equal(p2.status, 0, p2.stderr + p2.stdout);
  assert.match(p2.stdout, /nothing was reset/);
  assert.equal(readFileSync(file, "utf8"), saved, "settings file untouched by an update");
});

test("docker-remove: stops the container, keeps the data unless --purge", () => {
  const fd = fakeDocker();
  const envDir = mkdtempSync(path.join(tmpdir(), "console-denv-"));
  writeFileSync(path.join(envDir, "old.env"), "X=1\n");
  const base = { PATH: `${fd.bin}:${process.env.PATH}`, CONSOLE_DOCKER_ENV_DIR: envDir };
  const keep = sh(`DOCKER_REMOVE=old; docker_remove`, base);
  assert.equal(keep.code, 0, keep.err);
  assert.ok(fd.calls().includes("rm -f console-old"));
  assert.ok(!fd.calls().some((c) => c.startsWith("volume rm")));
  assert.ok(!exists(path.join(envDir, "old.env")));
  assert.match(keep.out, /data is kept/);
  writeFileSync(path.join(envDir, "old.env"), "X=1\n");
  const purge = sh(`DOCKER_REMOVE=old; DOCKER_PURGE=1; docker_remove`, base);
  assert.ok(fd.calls().includes("volume rm console-old-data"));
  assert.equal(purge.code, 0, purge.err);
});

test("--docker name parsing; a bad name is refused before anything runs", () => {
  assert.equal(sh(`parse_args --docker mc-test --yes; echo "$DOCKER_MODE $DOCKER_NAME"`).out.trim(), "1 mc-test");
  assert.equal(sh(`parse_args --docker --yes; echo "$DOCKER_MODE [$DOCKER_NAME]"`).out.trim(), "1 []");
  assert.equal(sh(`parse_args --docker 'Bad Name'`).code, 1);
  assert.equal(sh(`parse_args --docker-remove '../x'`).code, 1);
});

// ---- friendlier ports, and the domain offer after it's reachable ------------------------------------
test("docker wizard: no port questions by default; picks free ports and says what they're for", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-dw-"));
  const r = sh(
    scripted(["minecraft-test", "1", "admin", "y", "n", "y"]) + `
HAVE_TTY=1; PUBLIC_IP=203.0.113.9
port_free() { [ "$1" != 3100 ] && [ "$1" != 25565 ]; }   # pretend 3100 and 25565 are taken
docker() { return 0; }
docker_wizard
echo "RESULT PORT=$D_PORT GAME=$D_PORTS PUBLIC=$D_PUBLIC NAME=$DOCKER_NAME"`,
    { CONSOLE_DOCKER_ENV_DIR: dir }
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /RESULT PORT=3101 GAME=25566 PUBLIC=1 NAME=minecraft-test/);
  assert.match(r.out, /Players join through port 25566/);
  assert.match(r.err + r.out, /25565 is taken by another server/);
  assert.doesNotMatch(r.out, /Dashboard port on this machine|Extra ports to publish/, "the scary questions are gone by default");
});

test("docker wizard: the ports/limits questions only appear if you ask for them", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "console-dw-"));
  const r = sh(
    scripted(["box", "2", "admin", "y", "y", "4444", "none", "n", "2g", "1.5", "", "y"]) + `
HAVE_TTY=1; PUBLIC_IP=203.0.113.9
port_free() { return 0; }
docker() { return 0; }
docker_wizard
echo "RESULT PORT=$D_PORT GAME=$D_PORTS PUBLIC=$D_PUBLIC MEM=$D_MEM CPUS=$D_CPUS"`,
    { CONSOLE_DOCKER_ENV_DIR: dir }
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /RESULT PORT=4444 GAME=none PUBLIC=0 MEM=2g CPUS=1\.5/);
  assert.match(r.out, /numbered door/);
});

test("reachability check: passes straight away, or guides through the cloud firewall and re-checks", () => {
  const ok = sh(`PUBLIC_IP=1.2.3.4; wait_for() { return 0; }; check_reachable 3000; echo rc=$?`);
  assert.match(ok.out, /Reachable from the internet at http:\/\/1\.2\.3\.4:3000/);
  const retry = sh(
    scripted([""]) + `
HAVE_TTY=1; PUBLIC_IP=1.2.3.4; IS_OCI=1; N=0
wait_for() { N=$((N+1)); [ "$N" -ge 2 ]; }
check_reachable 3000; echo rc=$? calls=$N`
  );
  assert.match(retry.err, /Oracle blocks everything/);
  assert.match(retry.err + retry.out, /Destination port 3000/);
  assert.match(retry.out, /rc=0 calls=2/);
  const skip = sh(scripted(["s"]) + `HAVE_TTY=1; PUBLIC_IP=1.2.3.4; wait_for() { return 1; }; check_reachable 3000 && echo rc=0 || echo rc=1`);
  assert.match(skip.out, /rc=1/);
  const unattended = sh(`HAVE_TTY=0; PUBLIC_IP=1.2.3.4; wait_for() { return 1; }; check_reachable 3000 && echo rc=0 || echo rc=1`);
  assert.match(unattended.out, /rc=1/, "never waits for a keypress when nobody is there");
});

test("docker instance + domain: own Caddy site file, private container, secure cookies, removed with the instance", () => {
  const fd = fakeDocker();
  const dir = mkdtempSync(path.join(tmpdir(), "console-dd-"));
  const caddy = path.join(dir, "caddy");
  mkdirSync(caddy);
  const env = { PATH: `${fd.bin}:${process.env.PATH}`, CONSOLE_DOCKER_ENV_DIR: path.join(dir, "env") };
  const r = sh(
    `CADDY_DIR='${caddy}'; DOMAIN=mc.example.com; PUBLIC_IP=1.2.3.4
install_caddy_binary() { :; }; setup_dns() { :; }; reload_or_start_caddy() { echo RELOAD; }; open_ports() { echo OPEN "$@"; }
caddy() { return 0; }; wait_for() { return 0; }
d_denv_set app CONSOLE_D_PORT 3105; d_denv_set app CONSOLE_D_PORTS 25565; d_denv_set app CONSOLE_D_PUBLIC 1
docker_attach_domain app
echo ---; cat "$CADDY_DIR/console-docker-app.caddy"; echo ---; cat "$CADDY_DIR/Caddyfile"; echo ---; cat "$(d_env_file app)"
docker_run_args app | tr '\\n' ' '; echo
DOCKER_REMOVE=app; docker_remove; ls "$CADDY_DIR"`,
    env
  );
  assert.equal(r.code, 0, r.err + r.out);
  assert.match(r.out, /mc\.example\.com \{[\s\S]*reverse_proxy 127\.0\.0\.1:3105/);
  assert.match(r.out, /import .*console-docker-\*\.caddy/);
  assert.match(r.out, /OPEN 80 443/);
  assert.match(r.out, /CONSOLE_D_PUBLIC=0/);
  assert.match(r.out, /CONSOLE_SECURE_COOKIES=1/);
  assert.match(r.out, /CONSOLE_TRUST_PROXY=1/);
  assert.match(r.out, /-p 127\.0\.0\.1:3105:3000/, "dashboard now only on loopback; Caddy is the front door");
  assert.match(r.out, /-p 127\.0\.0\.1:25565:25565|-p 0\.0\.0\.0:25565:25565/);
  assert.ok(!r.out.split("\n").slice(-3).join("\n").includes("console-docker-app.caddy"), "site file removed with the instance");
});
