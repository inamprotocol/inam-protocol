import { Router } from "express";
import * as transparencyService from "../services/transparencyService.js";
import { parsePageParams } from "../../sdk-js/src/core/pagination.js";
import { rateLimitReadByIp } from "../middleware/rateLimit.js";
import { badRequest } from "../middleware/errors.js";

export const transparencyRouter = Router();

transparencyRouter.get("/sth", rateLimitReadByIp, (_req, res) => {
  res.json(transparencyService.getSTH());
});

transparencyRouter.get("/entries", rateLimitReadByIp, (req, res) => {
  const rawLimit = typeof req.query.limit === "string" ? req.query.limit : undefined;
  const rawOffset = typeof req.query.offset === "string" ? req.query.offset : undefined;
  const { limit, offset } = parsePageParams(rawLimit, rawOffset);
  const { entries, total } = transparencyService.getEntries(limit, offset);
  res.json({ entries, hasMore: offset + limit < total });
});

function parseIntParam(raw: unknown, name: string): number {
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isFinite(n)) {
    throw badRequest("VALIDATION_ERROR", `${name} must be an integer`);
  }
  return n;
}

transparencyRouter.get("/proof/inclusion", rateLimitReadByIp, (req, res) => {
  const leafIndex = parseIntParam(req.query.leafIndex, "leafIndex");
  const treeSize = req.query.treeSize !== undefined ? parseIntParam(req.query.treeSize, "treeSize") : undefined;
  res.json(transparencyService.getInclusionProof(leafIndex, treeSize));
});

transparencyRouter.get("/proof/consistency", rateLimitReadByIp, (req, res) => {
  const first = parseIntParam(req.query.first, "first");
  const second = req.query.second !== undefined ? parseIntParam(req.query.second, "second") : undefined;
  res.json(transparencyService.getConsistencyProof(first, second));
});
