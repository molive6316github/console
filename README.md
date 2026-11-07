# Console

A small web dashboard for starting, stopping and watching all kinds of servers. Every server type is a **driver** behind one tiny interface, so the dashboard doesn't care what's underneath.

**Status: v0.1** (single machine, roles in place, no per-server permissions yet)

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

## Defining servers

`servers.json` is the source of truth and is synced into the database on every start. See `servers.example.json` for one of each type.

| type | what it does | target |
|---|---|---|
| `docker` | start/stop/restart a container | `{ "container": "name" }` |
| `systemd` | systemd unit on any Linux box over SSH | `{ "host": "user@host", "unit": "nginx.service", "sudo": true }` |
| `tmux` | long-running process in a tmux session (game servers) | `{ "session", "startCommand", "cwd", "stopCommand" }` |
| `http` | read-only "is this site alive?" | `{ "url", "expectStatus" }` |
| `dummy` | fake, for development | `{ "startsUp": true }` |

`systemd` needs key-based SSH (and passwordless sudo if `sudo` is true).
`tmux` with a `stopCommand` (e.g. `stop` for Minecraft) asks the process to exit nicely, waits, then force-kills.

## Adding a driver

Drop a file in `server/src/drivers/`, export an object with `type`, `status`, `start`, `stop`, `restart` (and `logs`), and register it in `drivers/index.js`.

```js
{
  type: "mything",
  status(target, ctx)  -> "up" | "down" | "unknown",
  start(target, ctx), stop(target, ctx), restart(target, ctx),
  logs(target, lines)  // stubbed in v0.1
}
```

## Roles

| role | can do |
|---|---|
| `viewer` | see status |
| `operator` | + start / stop / restart |
| `admin` | + read the audit log |

Every login and every action is written to the audit log (who, what, which server, success or failure).

## Deploying publicly (Oracle Cloud / any Ubuntu VPS)

The setup is: Console listens on loopback, **Caddy** faces the internet and handles HTTPS. Don't expose port 3000 directly: logins would cross the internet in cleartext.

You need a domain (or subdomain) with an A record pointing at the server's public IP.

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
- Update later with `cd /opt/console && sudo -u console git pull && sudo -u console npm install && sudo -u console npm run build && sudo systemctl restart console`.

## Security notes

- Binds to `127.0.0.1` by default; the section above is the supported way to expose it. If you set `HOST=0.0.0.0` anyway, it prints a warning unless `CONSOLE_SECURE_COOKIES=1`.
- Only set `CONSOLE_TRUST_PROXY=1` when a proxy you control sits in front, otherwise clients can fake their IP and dodge the login rate limit.
- Responses carry CSP, `X-Frame-Options: DENY`, `nosniff`, and HSTS (when secure cookies are on).
- Server targets (hosts, commands, paths) never leave the backend.
- Drivers run commands without a shell, and every name that reaches a command line is regex-validated.
- Only whoever can edit `servers.json` can define what runs. There is no way to add servers or commands through the web UI.
- Passwords are scrypt-hashed, sessions are random tokens stored hashed, cookies are `HttpOnly` + `SameSite=Strict`, login is rate limited.

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

## Roadmap

- **v0.2 staff:** user management UI, per-server permissions, logs viewer
- **v0.3 open source:** setup script, Dockerfile, screenshots, license
- Later: metrics, file browser, notifications when something goes down

## License

TBD before v0.3.
