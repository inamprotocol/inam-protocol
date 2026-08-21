import express from "express";
import { agentsRouter } from "./routes/agents.js";
import { receiptsRouter } from "./routes/receipts.js";
import { errorHandler } from "./middleware/errors.js";

export function createServer() {
  const app = express();

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

  app.use((req, res) => {
    res.status(404).json({ error: { code: "ROUTE_NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
  });

  app.use(errorHandler);

  return app;
}
