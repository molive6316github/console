import { audit } from "../db.js";
import { LinuxUserError } from "../linuxusers.js";

export function linuxRoutes(app, { db, need, linux, safeMode, featureOn }) {
  const guard = [
    need("admin"),
    async (req, reply) => {
      if (safeMode) return reply.code(403).send({ error: "Safe mode is on: managing Linux users is disabled" });
      if (!featureOn()) return reply.code(403).send({ error: "Linux user management is turned off. An admin can turn it on in Settings." });
    },
  ];
  const wrap = (action, fn) => async (req, reply) => {
    try {
      const out = await fn(req);
      audit(db, { username: req.user.username, action: `linux_${action}`, ok: true, detail: `${req.params?.name ?? req.body?.name ?? ""}` });
      return out ?? { ok: true };
    } catch (e) {
      if (e instanceof LinuxUserError) {
        audit(db, { username: req.user.username, action: `linux_${action}`, ok: false, detail: `${req.params?.name ?? req.body?.name ?? ""}: ${e.message}` });
        return reply.code(e.status).send({ error: e.message });
      }
      throw e;
    }
  };

  app.get("/api/linux/users", { preHandler: guard }, wrap("list", async () => linux.list()));
  app.post("/api/linux/users", { preHandler: guard }, wrap("create", async (req) => linux.create({ name: req.body?.name, sudo: req.body?.sudo === true, key: req.body?.key || undefined })));
  app.get("/api/linux/users/:name/keys", { preHandler: guard }, wrap("keys", async (req) => linux.keys(req.params.name)));
  app.post("/api/linux/users/:name/keys", { preHandler: guard }, wrap("key_add", async (req) => ({ fingerprint: await linux.addKey(req.params.name, req.body?.key) })));
  app.post("/api/linux/users/:name/keys/remove", { preHandler: guard }, wrap("key_remove", async (req) => linux.removeKey(req.params.name, req.body?.fingerprint).then(() => ({ ok: true }))));
  app.post("/api/linux/users/:name/sudo", { preHandler: guard }, wrap("sudo", async (req) => linux.setSudo(req.params.name, req.body?.on === true)));
  app.post("/api/linux/users/:name/delete", { preHandler: guard }, wrap("delete", async (req) => linux.remove(req.params.name, { deleteHome: req.body?.deleteHome === true, confirm: req.body?.confirm })));
}
