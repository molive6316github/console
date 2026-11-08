import { audit } from "../db.js";
import { SetupError } from "../setups/index.js";
import { RepoError } from "../gitutil.js";

export function setupRoutes(app, { db, need, setups, jobs, safeMode }) {
  const guard = [need("admin"), async (req, reply) => safeMode && reply.code(403).send({ error: "Safe mode is on (CONSOLE_SAFE_MODE=1): setting things up is disabled" })];
  const wrap = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (e) {
      if (e instanceof SetupError || e instanceof RepoError) return reply.code(e.status ?? 400).send({ error: e.message });
      throw e;
    }
  };

  app.get("/api/setup/catalog", { preHandler: need("admin") }, async () => setups.catalog());
  app.get("/api/setup/status", { preHandler: need("admin") }, async () => setups.status());
  app.get("/api/setup/minecraft/versions", { preHandler: need("admin") }, wrap(async (req, reply) => {
    const flavor = String(req.query?.flavor ?? "paper");
    if (!setups.flavors[flavor]) return reply.code(400).send({ error: "Unknown server type" });
    try {
      return { versions: await setups.versions(flavor) };
    } catch (e) {
      return reply.code(502).send({ error: e.message });
    }
  }));

  app.post("/api/setup/:template", { preHandler: guard }, wrap(async (req) => {
    const job = setups.start(req.params.template, req.body, req.user.username);
    return { jobId: job.id };
  }));

  app.post("/api/servers/:id/git-update", { preHandler: guard }, wrap(async (req) => {
    const job = setups.updateApp(req.params.id, req.user.username);
    return { jobId: job.id };
  }));
  app.get("/api/servers/:id/git", { preHandler: need("admin") }, async (req) => {
    const m = setups.metaOf(req.params.id);
    return m ? { repo: m.repo, branch: m.branch, kind: m.kind } : null;
  });

  app.get("/api/jobs", { preHandler: need("admin") }, async () => jobs.list());
  app.get("/api/jobs/:id", { preHandler: need("admin") }, async (req, reply) => {
    const j = jobs.get(req.params.id, Math.max(0, parseInt(req.query?.since ?? "0", 10) || 0));
    return j ?? reply.code(404).send({ error: "No such job (Console may have restarted)" });
  });
}
