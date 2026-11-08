import { createHub } from "./hub.js";
const token = process.env.HUB_ADMIN_TOKEN;
if (!token) { console.error("Set HUB_ADMIN_TOKEN (16+ random chars). Example: HUB_ADMIN_TOKEN=$(openssl rand -hex 24) node hub/index.js"); process.exit(1); }
const hub = createHub({ dbPath: process.env.HUB_DB ?? "hub.db", adminToken: token });
hub.server.listen(Number(process.env.PORT ?? 8787), process.env.HOST ?? "127.0.0.1", () => console.log(`Console Link hub on ${process.env.HOST ?? "127.0.0.1"}:${process.env.PORT ?? 8787}`));
