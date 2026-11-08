# Console

A small web dashboard for starting, stopping and watching all kinds of servers. Every server type is a **driver** behind one tiny interface, so the dashboard doesn't care what's underneath.

**Status: v0.2**: live logs and commands, add servers from the browser, staff accounts with per-server access, down alerts, host metrics, schedules, a file editor and backups.

## Quick start

Needs Node 22.13+.

```bash
npm install
npm run build          # builds the frontend into web/dist
npm start              # http://127.0.0.1:3000
```

First run creates `servers.json` (3 fake demo servers) and an `admin` account. The generated password is printed **once** in the terminal. To pick your own:

```bash
CONSOLE_ADMIN_PASSWORD='something-long' npm start
```

Dev mode with hot reload (two terminals): `npm run dev:server` and `npm run dev:web` (open http://localhost:5173).

Tests: `npm test`

## Run it from npm

```
npx mxt-console                      # dashboard on http://127.0.0.1:3000, data in ~/.mxt-console
npx mxt-console start --port 4000 --data ./my-data
sudo npx mxt-console install --minecraft    # full install: service, HTTPS, firewall, setup wizard
sudo npx mxt-console docker my-sandbox      # isolated Docker instance
```

Needs Node 22.13+. The first start prints an admin login once (or set `CONSOLE_ADMIN_PASSWORD`). `install` and `docker` run the same installer as the curl command, which fetches the latest Console from GitHub. Publishing: `npm publish` (the build runs automatically).

## Setup wizard

Run the install command in a terminal and it walks you through five short steps, then checks the dashboard from the internet (and tells you exactly which cloud-firewall rule to add if it can't), then offers to put your own domain on it with HTTPS (DNS on Cloudflare is automatic): what the machine is for (Minecraft host or general), your admin account (type a password or let it generate one), how you'll reach it (starts on the server's IP; no port questions unless you ask for them), GitHub (token and org), and extras (time zone, backups to keep, a Discord/Slack alert webhook, the advanced web terminal and Linux-user tools). It shows a summary and asks before it changes anything. Run it again with `--reconfigure` to change mode or address later. With `--yes` (or no terminal) it asks nothing; pass the same choices as environment variables: `CONSOLE_ADMIN_PASSWORD`, `CONSOLE_GITHUB_TOKEN`, `CONSOLE_GITHUB_ORG`, `CONSOLE_TIMEZONE`, `CONSOLE_ALERT_WEBHOOK`, `CONSOLE_BACKUP_KEEP`, `CONSOLE_ENABLE_TERMINAL=1`, `CONSOLE_ENABLE_LINUX_USERS=1`. Console applies these once on first start, only where nothing is saved yet, then the installer removes them from `/etc/console.env`.

## Docker instances (isolated Consoles)

Run the installer in a terminal and pick **Create or update an isolated Docker instance** (it asks every time, even on a machine that already has Console). Each instance is its own Console in a container: its own admin account, dashboard port, servers and files, kept in a Docker volume named `console-<name>-data`. It runs **side by side** with the main install and with other instances, and cannot see the host's files, services or other instances. Good for things you share, separate projects, testing, or keeping configs apart.

- Includes Java 21, so Minecraft servers run inside it. Publish the game port when asked (25565 is the default in Minecraft mode); two instances can't both publish the same port.
- Hardened: all Linux capabilities dropped, no new privileges, no host mounts, optional memory and CPU limits, optionally reachable from this machine only (use an SSH tunnel).
- Servers running inside stop if the container restarts (their files stay in the volume); start them again from its dashboard.
- Update: run the installer again, pick Docker, give the same name. It rebuilds the image and keeps the data.
- No terminal? `sudo bash install.sh --docker NAME --yes` (set `CONSOLE_DOCKER_PORT`, `CONSOLE_DOCKER_PORTS`, `CONSOLE_ADMIN_PASSWORD`, and `CONSOLE_MODE_FLAG=minecraft` if you want).
- Remove: `sudo bash install.sh --docker-remove NAME` (add `--purge` to delete its data too).
- Not done: HTTPS for an instance. Put the host's Caddy in front of its port, or use the SSH tunnel.

## What you can do

| | |
|---|---|
| **Servers** | Start / stop / restart, status dots, 24h uptime. |
| **Console** | Live output (refreshes every 2 seconds) and a command box that types into the server. Works for `tmux` servers (Minecraft etc.); logs also work for Docker and systemd. |
| **Files** | Edit text files (`server.properties`, configs) in the browser, confined to the server's folder. |
| **Backups** | One-click `.tar.gz` of the server's folder, automatic pruning, download. |
| **Schedules** | Cron-style: restart at 4am, back up on Sundays, send `say Restarting soon` at 3:55. |
| **Alerts** | Discord or Slack webhook when a server that should be up goes down, and when it recovers. |
| **Host** | CPU, memory and disk now and over 1h / 6h / 24h / 7d. |
| **Users** | Staff accounts, each limited to the servers you pick. |
| **Discover** | Scans the machine for tmux sessions, Docker containers, systemd services, big processes and folders, shows what Console can and can't see, and lets you add them to Console or clean them up. |
| **Audit log** | Every login, action, command, file edit, deletion and settings change. |

## Defining servers

Two ways, and you can mix them:

- **In the browser:** **Add server** on the Servers page (admins). These can be edited and removed in the UI.
- **In `servers.json`:** the file is synced into the database on every start. These servers are read-only in the UI ("edit it in servers.json"). Removing one from the file removes it from Console. Servers you added in the browser are never touched by the file.

See `servers.example.json` for one of each type.

| type | what it does | target |
|---|---|---|
| `docker` | start/stop/restart a container | `{ "container": "name" }` |
| `systemd` | systemd unit, over SSH or on this machine | `{ "host": "user@host" or "local", "unit": "nginx.service", "sudo": true }` |
| `tmux` | long-running process in a tmux session (game servers) | `{ "session", "startCommand", "cwd", "stopCommand", "stopTimeoutSec" }` |
| `http` | read-only "is this site alive?" | `{ "url", "expectStatus" }` |
| `dummy` | fake, for development | `{ "startsUp": true }` |

`systemd` needs key-based SSH (and passwordless sudo if `sudo` is true).
`tmux` with a `stopCommand` (e.g. `stop` for Minecraft) asks the process to exit nicely, waits, then force-kills.

**Files and backups** work on any server with a folder on this machine: set `filesRoot` (docker, dummy) or `cwd` / `filesRoot` (tmux). `systemd` (remote) and `http` servers have no local folder, so they don't get those tabs.

```json
{ "id": "survival", "name": "Survival SMP", "type": "tmux",
  "target": { "session": "survival", "cwd": "/srv/survival", "startCommand": "java -Xmx4G -jar server.jar nogui", "stopCommand": "stop" } }
```

## Adding a driver

Drop a file in `server/src/drivers/`, export an object with `type`, `status`, `start`, `stop`, `restart` (and `logs`), and register it in `drivers/index.js`.

```js
{
  type: "mything",
  status(target, ctx)  -> "up" | "down" | "unknown",
  start(target, ctx), stop(target, ctx), restart(target, ctx),
  logs(target, lines, ctx) -> string,
  validate(target) -> cleaned target   // used when servers are added in the UI; throw TargetError on bad input
  send(target, text)                   // optional: type a line into the server
}
```

## Roles and access

| role | can do |
|---|---|
| `viewer` | see status and logs |
| `operator` | + start / stop / restart, send commands |
| `admin` | + everything else: add/edit servers, files, backups, schedules, users, settings, audit log, updates |

Each non-admin user is either allowed **all servers** or **only the ones you pick**. A server they can't access doesn't show up for them and answers "no such server" if they guess its address. Scoped users also don't see the Host page (machine-wide numbers).

Changing a user's role, servers or password signs them out immediately. You can't delete or demote yourself, and the last admin can't be removed.

Everyone can change their own password (**Account**, 10+ characters). Forgot the admin password? Stop the service, delete `data/console.db*`, set `CONSOLE_ADMIN_PASSWORD`, start it again. That wipes users, schedules, history and the audit log (servers from `servers.json` come back; servers added in the browser do not).

## Discover and clean up

On its very first start, Console **adds what it finds already running** (tmux sessions, Docker containers, and systemd services you installed yourself) so the dashboard isn't empty. It happens once; anything you remove stays removed. tmux sessions started by hand have no known start command, so check each one's Settings tab. Skipped in safe mode.

**Discover** (admin) looks at the machine Console runs on. Each item has **Add to Console**, which opens the add-server form filled in.

- **tmux sessions** with their folder and the command they were started with. tmux sessions belong to the Linux user that started them. When Console runs as the same user (the default on Oracle: `opc`), it sees them all; if it runs as a different user it lists that other users' sessions exist but can't control them.
- **Docker containers and images**, with which images are unused. Needs the Console user in the `docker` group (`sudo usermod -aG docker opc`, then Settings → Restart Console).
- **systemd services**: ones you installed (`/etc/systemd/system`), plus system ones on request. Added as `host: "local"`. Controlling a system service as a non-root user needs a sudoers rule; the error message shows the exact line.
- **Running processes** (read-only) to spot things started some other way.
- **Folders** directly inside `/srv`, `/opt` and each `/home/<user>`, with sizes and what they look like (Minecraft, Node, Docker Compose…). Add more places with `CONSOLE_SCAN_DIRS=/mnt/games:/data` (colon-separated).

**Deleting** is deliberate:

- **Kill a tmux session / remove a container or image / prune** stopped containers and untagged images. Docker volumes are never touched. Anything that is a Console server must be removed from Console first (or use its Stop button).
- **Delete a folder** only works on folders that the scan lists. You must type its exact name, and it offers to save a compressed copy first (on by default; if the copy fails, nothing is deleted). It refuses Console itself, its database, any folder a Console server uses, a folder something is still running from, symlinks, and top-level system folders.
- **Console's own leftovers**: backups of servers you removed and the saved copies from folder deletions.
- Everything here is in the audit log, and is disabled in safe mode (scanning still works). Deleting can only remove what that user owns; if some files belong to another user, Console says so instead of pretending it worked.

## Create: one-click setups

**Create** (admin) is the beginner-friendly front door. Pick a card, fill in a few boxes, watch the progress, done. Everything it makes becomes a normal Console server you can start, stop, watch, back up and schedule.

- **Minecraft server**: Paper, Vanilla, Purpur or Fabric, with a version picker (lists come from the vendors' own APIs). Console downloads the jar, installs the right Java if it's missing (needs passwordless sudo, which `opc` has on Oracle), writes `eula.txt` only after you tick the EULA box, opens the firewall port if you ask, and starts it in tmux with a `stop` command so shutdowns are clean. You still need an Oracle VCN ingress rule for the port.
- **App or bot from GitHub** (Node.js or Python): paste `owner/repo` or a link. Console clones it, installs dependencies (`npm install`, or a `.venv` + `pip`), saves your settings/secrets to a private `.env` (mode 600, never shown again), works out the start command (or you give one), and runs it in tmux, optionally restarting 5 seconds after any crash. **Update from GitHub** is a button on the server's Settings tab.
- **Website**: a domain with automatic HTTPS through Caddy, from a blank starter page or a GitHub repo (with an optional `npm run build` and a folder to publish). Point the domain's A record at the server; Console writes a small file in `/etc/caddy/sites`, validates the config, and reloads Caddy only if it's valid. Needs Caddy, which the installer sets up when you give it a domain (re-run the installer once to prepare the folders).
- **Docker app**: Uptime Kuma, Portainer, Vaultwarden, Nginx Proxy Manager, File Browser, or any image you name (ports and environment variables included). Data lives in named Docker volumes. Add your own favorites in `server/src/setups/dockerapps.js`.
- **Find what's already here** and **Add one by hand** are on the same page.

**Private repositories:** Settings → GitHub access. Use a fine-grained token with read-only "Contents" access to just the repos you want. It is stored on this machine, masked afterwards, sent to GitHub only through git's environment (never the command line or `.git/config`), and scrubbed from logs.

Everything Create does is audited and disabled in safe mode. Clone targets are limited to github.com, gitlab.com and codeberg.org over https. Apps go in `~/servers/<id>` (change with `CONSOLE_APPS_DIR`).

## Beginner to advanced

The selector at the top right (also under Settings) sets how much you see, per browser:

- **Simple**: Servers, Create, Settings, Account. Forms ask only the essentials.
- **Standard**: adds Host, Discover, Schedules, Users and Updates, and the "More options" in forms.
- **Advanced**: adds the Audit log, raw ID fields, and (once switched on) the Terminal and Linux users.

It only changes what's shown. It never changes what anyone is allowed to do; roles and per-server access still decide that.

## Minecraft mode

Install on a fresh box with the Minecraft flavour:

```
curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh | sudo bash -s -- --minecraft
```

(`--standard` switches back.) Console then becomes a one-server Minecraft panel (think PebbleHost, self-hosted): it opens straight into your server with a left sidebar. First visit as owner shows a "Make your Minecraft server" screen (type, version, memory).

**The panel**

- **Overview**: big Start / Restart / Stop, the address to give friends (copy button), players online, version, live CPU / memory graphs (last hour) and TPS.
- **Startup & memory**: RAM slider, Java flag presets (Aikar's optimized flags) plus a short allow-list for custom flags (anything that could run code is refused), restart-on-crash (up to 3 tries per 30 minutes, then it alerts you), and an optional daily restart with a 5 minute in-game warning. Applies on the next start.
- **Version**: switch between Paper, Purpur, Fabric and Vanilla and any version. Server must be stopped, a full backup is taken first, and the old server jar is kept next to the new one. Changing server type or going to an older version needs an explicit tick.
- **People & invites**: invite by link. Pick a role (Helper, Moderator, Admin) or tick exact permissions (console, commands, power, players, settings, startup, version, plugins, files, backups, activity). Links work once, expire (1 / 7 / 30 days) and are shown only when you create them. Owners alone manage people. Changing someone's permissions signs them out so it takes effect immediately.
- **Join address & status page**: set a domain, see the exact A / SRV records to create, and optionally turn on a public `/status.html` page (online or not, player count, address; player names only if you allow them).
- **Activity**: who did what, scoped to this server.

Everything below (players, settings, plugins, files, backups) lives in the same sidebar, and each item only shows up for people who have that permission. Any server that has a `server.properties` gets:

- **Players**: who's online, whitelist / ops / bans, kick, ban, op, say, time, weather, gamemode (fixed command templates, nothing is passed through raw).
- **Game settings**: a proper editor for `server.properties` (a `.console-bak` copy is kept; passwords are masked).
- **Plugins / Mods**: list, disable, enable, delete; install from Modrinth (hash-checked) or from GitHub releases (a team org works: set the org in Settings, pick a repo, pick the jar). Downloads only come from fixed hosts.
- **Worlds & backups**:
  - *Safe backup*: on a running server Console runs `save-off`, `save-all flush`, copies, then `save-on` (always, even if the copy fails).
  - *Restore*: server must be stopped and you type the server ID. The current folder is renamed `<folder>.before-restore-<time>`, never deleted. Archives with unsafe paths are refused.
  - *New world*: moves the world folders into `old-worlds/<time>/`.
  - *GitHub configs*: pushes `server.properties`, lists, and plugin/mod config files to branch `servers/<id>` of a private repo. Lines that look like passwords/tokens/API keys are blanked in the copy (a heuristic, so keep the repo private). Jars and worlds are never included.
  - *GitHub worlds*: uploads the world as a release file (limit 2 GB) and prunes old ones past "keep".
  - Schedules can run **Safe world backup**, **Back up configs to GitHub** and **Back up world to GitHub**.

The GitHub token needs write access to *Contents* on the backup repo. Open TCP 25565 in your cloud firewall (Oracle: VCN security list) or nobody can join.

## Web terminal and Linux users (advanced, off by default)

Both are switched on by an admin under **Settings → Advanced tools**, are admin-only, are blocked by safe mode, and are written to the audit log.

- **Terminal**: a real shell in your browser (opens in its own tab, `/terminal.html`), running as the same Linux user as Console. Sessions are logged (who, from where, for how long); what you type is not, because that would capture passwords. Secrets Console was started with (`CONSOLE_*`, `CF_*`) are removed from the shell's environment. It checks the browser's origin, allows 3 sessions at once, closes after 30 idle minutes, and ends immediately if you sign out, are demoted, or the switch is turned off.
- **Linux users**: list the real accounts, create one (SSH-key login, no password), add or remove SSH keys (only genuine one-line public keys are accepted; `command=` style options are refused), grant or remove sudo, delete a user (type the name to confirm; the home folder is only deleted if you tick the box). It uses `sudo -n` with each value passed separately, never through a shell string. It refuses to touch system accounts and the account Console itself runs as.

## Running as `opc` (or any login user)

The installer runs Console as **the user who ran it with sudo** (so `opc` on Oracle), because that's the account your tmux sessions, Docker access and files already belong to. Override with `--user NAME`; with nobody to pick, it creates a locked-down `console` user instead. The choice is remembered (`CONSOLE_RUN_USER` in `/etc/console.env`). A login user's service doesn't set `NoNewPrivileges`, since Console needs `sudo` for Java, firewall, Caddy and Linux users.

## Alerts, schedules, metrics

- **Alerts:** Settings → paste a Discord (or Slack) webhook URL → Send test alert. Console checks every server once a minute. A server that has been seen running and is then down for 2 checks in a row triggers one message, and one more when it's back. **Stopping a server from Console, or from a schedule, never alerts.** The webhook is stored in the database and is never shown in full again.
- **Schedules:** `minute hour day-of-month month day-of-week`, in the time zone you set under Settings (the server is usually on UTC, so set yours). Each runs at most once a minute. If Console was off at that minute, that run is skipped. An action already in progress on the same server makes the scheduled one skip rather than pile up.
- **Backups:** `tar` of the server's folder. For a live Minecraft world, schedule a command like `save-all` a minute before the backup, or stop it first. Restoring is manual: download, unpack. Older backups are deleted automatically (default keep 7, Settings).
- **Metrics:** CPU, memory and disk of this machine, sampled every minute, kept for 7 days. Per-server uptime is the share of checks in the last 24 hours that found it running.

## Deploying publicly (Oracle Cloud / any VPS)

One command installs everything (Node, the service, config, firewall) or updates an existing install. It works on Oracle Linux / RHEL-family and Debian / Ubuntu, needs root and systemd, and is safe to run again:

```bash
curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh | sudo bash
```

From a terminal it asks whether you have a domain. At the end it prints where to open Console and the admin password (shown once).

**With a domain (HTTPS):**

```bash
curl -fsSL https://raw.githubusercontent.com/molive6316github/console/main/install.sh \
  | sudo env CF_API_TOKEN=xxxx bash -s -- --domain console.example.com
```

It installs Caddy (the HTTPS certificate is automatic), puts Console behind it on loopback, turns on secure cookies, opens ports 80 and 443, and, **if the domain is on Cloudflare and you give it a token, creates the DNS record itself** (`scripts/cf-dns.mjs`, DNS-only record pointing at the server's IP). Without a token it prints the exact record to add by hand, and Caddy picks it up when it appears. Make the token at https://dash.cloudflare.com/profile/api-tokens with the "Edit zone DNS" template, limited to your zone. It is used once and never stored or printed.

**Without a domain:** plain HTTP at `http://<server-ip>:3000`. Fine to start with if you limit the firewall rule to your own IP. Run the command again with `--domain` whenever you get one.

Running it again updates Console and keeps your settings (it remembers the domain, never resets your accounts, and never touches `servers.json`). Flags: `--domain`, `--ip-only`, `--port`, `--branch`, `--dir`, `--yes`. `--help` lists them. `CONSOLE_ADMIN_PASSWORD=... ` picks the first admin password instead of a generated one.

**The one thing it can't do for you: the cloud provider's own firewall.** The installer opens the firewall on the machine itself, but on Oracle Cloud you must also add an ingress rule in the web console (Networking > your VCN > Security Lists > Add Ingress Rules, TCP, ports 80 and 443 for a domain or 3000 without one). With no domain, set the source to your own IP `/32`.

### Doing it by hand

This is what the installer automates. Console listens on loopback, **Caddy** faces the internet and handles HTTPS. Don't expose port 3000 directly: logins would cross the internet in cleartext. You need a domain (or subdomain) with an A record pointing at the server's public IP.

```bash
# 1. user + code
sudo useradd --system --create-home --shell /bin/bash console
sudo git clone https://github.com/molive6316github/console /opt/console   # private repo: use a deploy key or token
sudo chown -R console:console /opt/console
cd /opt/console && sudo -u console npm install && sudo -u console npm run build

# 2. config (edit both files)
sudo cp deploy/console.env.example /etc/console.env && sudo chmod 600 /etc/console.env
sudo -u console cp servers.example.json servers.json

# 3. run as a service
sudo cp deploy/console.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now console
sudo journalctl -u console -n 20      # confirm it started

# 4. HTTPS front door
sudo apt install -y caddy
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile      # put your domain in it first
sudo systemctl reload caddy
```

**Oracle-specific: two firewalls both need ports 80 and 443 open.**
1. In the Oracle console: VCN → Security List (or NSG) → add ingress rules, TCP, source `0.0.0.0/0`, ports 80 and 443.
2. On the instance itself (Ubuntu images ship with strict iptables rules): run `sudo iptables -L INPUT --line-numbers`, then insert ACCEPT rules for 80 and 443 *above* the REJECT line, e.g. `sudo iptables -I INPUT 5 -p tcp --dport 80 -j ACCEPT`, same for 443, then `sudo netfilter-persistent save`.

Notes:
- Game servers started by the `tmux` driver run as the same user as Console (`opc` by default; `console` if you chose that). Restarting the dashboard does not kill them (`KillMode=process`). Attach with `tmux attach -t uhc` as that user.
- For the `docker` driver, add the user to the docker group: `sudo usermod -aG docker console`. Know that this is root-equivalent on that machine.
- Console controls real processes, so treat the admin password like an SSH key. Use a long one.
- **Updating:** run the install command again, or sign in as admin, click **Updates**, then **Update now**. It fast-forwards from GitHub, runs `npm install` and `npm run build`, and restarts itself (the page reloads when it's back). If the install or build fails it rolls back to the previous version. It refuses to run if tracked files have local edits. This relies on `Restart=on-failure` in the systemd unit: after an update the process exits with code 75 and systemd starts it again.
- The user Console runs as must be able to `git fetch` from the repo. With the public repo that just works. If the Updates panel ever says it can't reach the repo, test with `sudo -u opc git -C /opt/console fetch origin main` (use your Console user).
- Manual update, if you ever need it: `cd /opt/console && sudo -u console git pull --ff-only && sudo -u console npm install && sudo -u console npm run build && sudo systemctl restart console`.

## Security notes

- **An admin account can run commands on this machine.** Adding a `tmux` server lets you set its start command, the command box types into a shell-capable process, and the file editor can change a start script. That is the point of the tool, but it means an admin password is as sensitive as an SSH key. Operators can send commands to servers they can access but can't change what runs.
- **Safe mode** (`CONSOLE_SAFE_MODE=1`) turns off adding/editing servers in the UI, the file editor, Create, the web terminal, Linux user management, and sending commands (including scheduled commands). Deleting from Discover is disabled too. Servers in `servers.json` and start/stop/restart still work. Use it if you'd rather define servers only by editing the file.
- Binds to `127.0.0.1` by default; the section above is the supported way to expose it. If you set `HOST=0.0.0.0` anyway, it prints a warning unless `CONSOLE_SECURE_COOKIES=1`.
- Only set `CONSOLE_TRUST_PROXY=1` when a proxy you control sits in front, otherwise clients can fake their IP and dodge the login rate limit.
- Responses carry CSP, `X-Frame-Options: DENY`, `nosniff`, and HSTS (when secure cookies are on).
- Server targets (hosts, commands, paths) never reach non-admins; admins only see them on a UI-added server's edit screen.
- The file editor is confined to the server's folder: `..`, absolute paths and symlinks that point outside are refused, saves are atomic, and it won't overwrite a file that changed since you opened it. Binary files and anything over 512 KB can't be opened.
- Drivers run commands without a shell, and every name that reaches a command line is regex-validated. Commands you type go into tmux as literal text.
- Passwords are scrypt-hashed, sessions are random tokens stored hashed, cookies are `HttpOnly` + `SameSite=Strict`, login is rate limited, and every state-changing request must be JSON.
- Webhook URLs must be `https://` and can't point at private or local addresses.

## Environment variables

| var | default |
|---|---|
| `PORT` | `3000` |
| `HOST` | `127.0.0.1` |
| `CONSOLE_DB` | `data/console.db` |
| `CONSOLE_SERVERS` | `servers.json` |
| `CONSOLE_ADMIN_USER` / `CONSOLE_ADMIN_PASSWORD` | `admin` / generated |
| `CONSOLE_SECURE_COOKIES` | off |
| `CONSOLE_TRUST_PROXY` | off |
| `CONSOLE_LOG` | off (`1` for request logs) |
| `CONSOLE_UPDATE_BRANCH` | `main` |
| `CONSOLE_SAFE_MODE` | off (`1` disables UI server editing, file editor, commands) |
| `CONSOLE_APPS_DIR` | `~/servers` (where Create puts Minecraft servers, bots and apps) |
| `CONSOLE_PUBLIC_IP` | set by the installer (used in "connect to…" hints) |
| `CONSOLE_MODE` | `minecraft` or `standard` (set by the installer flags). |
| `CONSOLE_RUN_USER` | set by the installer (the Linux user Console runs as) |
| `CONSOLE_CADDY_SITES` / `CONSOLE_SITES_ROOT` | `/etc/caddy/sites` / `/srv/sites` (Website setup) |
| `CONSOLE_SCAN_DIRS` | none (colon-separated extra folders for Discover to list) |
| `CONSOLE_MONITOR_SEC` | `60` (how often to check servers / sample metrics / alert; `0` = off) |

## Roadmap

- Next: two-factor login, restoring a backup from the UI, email alerts, per-server CPU/RAM (docker stats), more one-click apps (Mumble, Valheim, Minecraft modpacks)
- **v0.3 open source:** screenshots, license, contribution guide

## License

MIT. See [LICENSE](LICENSE).
