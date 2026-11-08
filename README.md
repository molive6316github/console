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

**Discover** (admin) looks at the machine Console runs on. Each item has **Add to Console**, which opens the add-server form filled in.

- **tmux sessions** with their folder and the command they were started with. tmux sessions belong to the Linux user that started them: Console runs as `console`, so it can't see or control sessions started as `opc` (it lists that those exist). To manage one, stop it and add it in Console so it runs as `console`.
- **Docker containers and images**, with which images are unused. Needs `sudo usermod -aG docker console`.
- **systemd services**: ones you installed (`/etc/systemd/system`), plus system ones on request. Added as `host: "local"`. Controlling a system service as `console` needs a sudoers rule; the error message shows the exact line.
- **Running processes** (read-only) to spot things started some other way.
- **Folders** directly inside `/srv`, `/opt` and each `/home/<user>`, with sizes and what they look like (Minecraft, Node, Docker Compose…). Add more places with `CONSOLE_SCAN_DIRS=/mnt/games:/data` (colon-separated).

**Deleting** is deliberate:

- **Kill a tmux session / remove a container or image / prune** stopped containers and untagged images. Docker volumes are never touched. Anything that is a Console server must be removed from Console first (or use its Stop button).
- **Delete a folder** only works on folders that the scan lists. You must type its exact name, and it offers to save a compressed copy first (on by default; if the copy fails, nothing is deleted). It refuses Console itself, its database, any folder a Console server uses, a folder something is still running from, symlinks, and top-level system folders.
- **Console's own leftovers**: backups of servers you removed and the saved copies from folder deletions.
- Everything here is in the audit log, and is disabled in safe mode (scanning still works). Deleting as the `console` user can only remove what that user owns; if some files belong to another user, Console says so instead of pretending it worked.

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
- Game servers started by the `tmux` driver run as the `console` user. Restarting the dashboard does not kill them (`KillMode=process`). Attach with `sudo -u console tmux attach -t uhc`.
- For the `docker` driver, add the user to the docker group: `sudo usermod -aG docker console`. Know that this is root-equivalent on that machine.
- Console controls real processes, so treat the admin password like an SSH key. Use a long one.
- **Updating:** run the install command again, or sign in as admin, click **Updates**, then **Update now**. It fast-forwards from GitHub, runs `npm install` and `npm run build`, and restarts itself (the page reloads when it's back). If the install or build fails it rolls back to the previous version. It refuses to run if tracked files have local edits. This relies on `Restart=on-failure` in the systemd unit: after an update the process exits with code 75 and systemd starts it again.
- The `console` user must be able to `git fetch` from the repo. With the public repo that just works. If the Updates panel ever says it can't reach the repo, test with `sudo -u console git -C /opt/console fetch origin main`.
- Manual update, if you ever need it: `cd /opt/console && sudo -u console git pull --ff-only && sudo -u console npm install && sudo -u console npm run build && sudo systemctl restart console`.

## Security notes

- **An admin account can run commands on this machine.** Adding a `tmux` server lets you set its start command, the command box types into a shell-capable process, and the file editor can change a start script. That is the point of the tool, but it means an admin password is as sensitive as an SSH key. Operators can send commands to servers they can access but can't change what runs.
- **Safe mode** (`CONSOLE_SAFE_MODE=1`) turns off adding/editing servers in the UI, the file editor, and sending commands (including scheduled commands). Deleting from Discover is disabled too. Servers in `servers.json` and start/stop/restart still work. Use it if you'd rather define servers only by editing the file.
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
| `CONSOLE_SCAN_DIRS` | none (colon-separated extra folders for Discover to list) |
| `CONSOLE_MONITOR_SEC` | `60` (how often to check servers / sample metrics / alert; `0` = off) |

## Roadmap

- Next: Dockerfile, per-server CPU/RAM (docker stats), email alerts, restoring a backup from the UI, two-factor login
- **v0.3 open source:** screenshots, license, contribution guide

## License

TBD before v0.3.
