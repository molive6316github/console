import websocket from "@fastify/websocket";

export function terminalRoutes(app, { need, terminal, safeMode }) {
  app.register(websocket, { options: { maxPayload: 70_000 } });
  app.register(async (scope) => {
    scope.get(
      "/api/terminal",
      {
        websocket: true,
        preValidation: async (req, reply) => {
          const deny = (code, error) => reply.code(code).send({ error });
          if (!req.user) return deny(401, "Not logged in");
          if (req.user.role !== "admin") return deny(403, "Requires role: admin");
          if (safeMode) return deny(403, "Safe mode is on: the terminal is disabled");
          if (!terminal.enabled()) return deny(403, "The terminal is turned off. An admin can turn it on in Settings.");
          // Cross-site WebSocket hijacking: the cookie is SameSite=Strict, and the page that opens this must be ours too.
          const origin = req.headers.origin;
          if (!origin || new URL(origin).host !== req.headers.host) return deny(403, "Bad origin");
          if (terminal.full()) return deny(429, "Too many open terminals");
        },
      },
      (socket, req) => {
        const q = req.query ?? {};
        terminal.attach(socket, {
          user: req.user,
          token: req.cookies?.console_session,
          ip: req.ip,
          cols: Number(q.cols),
          rows: Number(q.rows),
          safeMode,
        });
      }
    );
  });
}
