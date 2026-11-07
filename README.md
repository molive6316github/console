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

## Security notes

- Binds to `127.0.0.1` by default. To expose it, put a reverse proxy with HTTPS in front, then set `CONSOLE_SECURE_COOKIES=1` and `CONSOLE_TRUST_PROXY=1`. Don't open port 3000 to the internet.
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
