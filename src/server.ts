import express from "express";
import { agentsRouter } from "./routes/agents.js";
import { receiptsRouter } from "./routes/receipts.js";
import { jobsRouter } from "./routes/jobs.js";
import { errorHandler } from "./middleware/errors.js";

export function createServer() {
  const app = express();

  // Every GET route in this API is a public read endpoint (SPEC.md §5 —
  // reputation, profiles, search, receipts) meant to be queryable from a
  // browser with no account needed, so it's safe to allow any origin. POST
  // routes get no CORS headers: they're server-to-server/agent-to-agent by
  // design, and auth there is a per-request signature, not an ambient
  // browser credential, so CORS wouldn't add real security anyway.
  app.use((req, res, next) => {
    if (req.method === "GET") res.header("Access-Control-Allow-Origin", "*");
    next();
  });

  app.use(
    express.json({
      // Capture the exact raw bytes so request-signature verification hashes
      // precisely what was sent, not a re-serialized (and therefore
      // potentially different) version of the parsed body.
      verify: (req, _res, buf) => {
        (req as express.Request).rawBody = Buffer.from(buf);
      },
    }),
  );

  app.get("/v1/health", (_req, res) => res.json({ status: "ok" }));
  app.use("/v1/agents", agentsRouter);
  app.use("/v1/receipts", receiptsRouter);
  app.use("/v1/jobs", jobsRouter);

  app.use((req, res) => {
    res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
