# Writing a Console plugin

A Console plugin is a folder with two files. Put it in `<data folder>/plugins/<id>/` (the Plugins page shows the exact path), then switch it on in **Console plugins**.

Plugins run **inside Console** with Console's permissions. Only install plugins you wrote or read.

## manifest.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One sentence on what it does.",
  "permissions": ["Plain-English list of what it touches"],
  "settings": [
    { "key": "message", "type": "text", "label": "Message", "default": "hi", "help": "Shown under the field" }
  ]
}
```

- `id`: lowercase letters, numbers and dashes, 2-40 characters.
- Setting `type`: `text`, `textarea`, `secret` (never shown again once saved), `number` (with `min`/`max`), `bool`, `color` (`#rrggbb`), `select` (with `options`: strings, or `{ "value", "label" }`).
- The Plugins page builds a settings form from this. Saving restarts the plugin.

## index.js

```js
export default function (ctx) {
  // runs when the plugin starts
}
```

An ES module with a default function. It may return `{ stop() {} }` or call `ctx.onStop(fn)` to clean up.

## The `ctx` object

| | |
|---|---|
| `ctx.id`, `ctx.dir` | the plugin id and its folder |
| `ctx.log(...)` | writes to the Console log |
| `ctx.settings.get()` | current settings as an object (defaults filled in) |
| `ctx.store.get(key, fallback)` / `ctx.store.set(key, value)` | small persistent JSON storage (200 KB total) |
| `ctx.mc.servers()` | `[{ id, name, root }]`, the Minecraft servers (`root` is the server folder on disk) |
| `ctx.mc.live(id?)` | `{ online, players: { online, max, names }, version, motd, address, level }` |
| `ctx.mc.run(command, id?)` | sends a console command to the game (no leading slash) |
| `ctx.on(event, fn)` | `player:join`, `player:leave` (`{ name, online }`), `server:up`, `server:down`, `tick` |
| `ctx.every(seconds, fn)` | repeat (5 seconds minimum) |
| `ctx.route(method, path, opts, handler)` | add a web address (see below) |
| `ctx.css(text)` | add CSS to the panel and to Console websites |
| `ctx.notify(text)` | send a message to the alert webhook from Panel settings |
| `ctx.fetch` | the standard `fetch` |

### Routes

```js
ctx.route("GET", "/hello/:name", { public: true }, async (req) => ({ greeting: `hi ${req.params.name}` }));
```

- `public: true` serves it at `/x/<id>/hello/...` with no login. Without it the route is admin-only at `/api/x/<id>/hello/...`.
- The handler gets `{ params, query, body, headers, method, ip, raw }` and returns either data (sent as JSON) or `{ status, headers, type, body }` for control. `raw` is the exact request text, for signature checks.
- Pages must be plain HTML with scripts and styles served as separate files from your own routes (no inline `<script>` or `style=`: the security policy blocks them).
- If a public route returns private data, check a key from `ctx.settings.get()` first.

## Rules of thumb

- Use only Node's built-in modules and `ctx`. There's no `npm install` for plugins.
- Never log secrets. Keep tokens in `secret` settings.
- Read files only inside `ctx.dir` or a Minecraft server's `root`.
- Keep handlers fast; they share Console's process.

Look at `server/plugins/` in Console for working examples: `announcer` (timers + commands), `public-api` (public JSON), `leaderboards` (a page with its own JS/CSS), `discord-bot` (events + signed webhooks), `themes` (CSS).
