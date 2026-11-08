# Console Link

A hosted dashboard for Minecraft servers on **any** host. Drop a jar in `plugins/`, paste a key, done.

```
Minecraft server --(jar pushes status every ~10s, gets queued commands back)--> hub <-- dashboard
```

- `plugin/`: the Paper/Spigot jar. Outbound HTTPS only (no ports, no RCON). `./build.sh` builds it.
- `hub/`: the ingest + public API (Node 22, SQLite). `HUB_ADMIN_TOKEN=$(openssl rand -hex 24) node hub/index.js`
- Dashboard (login, buttons, public status widget): next.

## Hub API
| | |
|---|---|
| `POST /v1/ingest` (Bearer server key) | server pushes `{version,max,tps,players[],done[]}`, gets `{commands[]}` |
| `GET /v1/public/:id` | public status JSON (only for servers marked public; names only if the owner allows) |
| `POST /v1/admin/servers` (Bearer admin token) | `{id,name,isPublic}` → `{id,key}` (key shown once) |
| `GET /v1/admin/servers[/:id]` | status |
| `POST /v1/admin/servers/:id/rotate` | new key |
| `POST /v1/admin/servers/:id/commands` | `{action: whitelist-add\|whitelist-remove\|op\|deop\|kick\|say, player\|message}` |

Safety: keys are stored hashed, commands are an allowlist checked by the hub **and** again by the plugin, no arbitrary console, per-server rate limit, stale = offline after 90s.
