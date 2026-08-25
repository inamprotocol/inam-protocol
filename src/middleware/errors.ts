import type { NextFunction, Request, Response } from "express";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFound(code: string, message: string): ApiError {
  return new ApiError(404, code, message);
}

export function badRequest(code: string, message: string): ApiError {
  return new ApiError(400, code, message);
}

export function unauthorized(code: string, message: string): ApiError {
  return new ApiError(401, code, message);
}

export function forbidden(code: string, message: string): ApiError {
  return new ApiError(403, code, message);
}

export function conflict(code: string, message: string): ApiError {
  return new ApiError(409, code, message);
}

export function tooManyRequests(code: string, message: string): ApiError {
  return new ApiError(429, code, message);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  // A malformed JSON body (e.g. `{invalid`) makes express.json() throw a
  // SyntaxError before any route handler runs -- body-parser (which
  // express.json() wraps) already tags it `status: 400, type:
  // "entity.parse.failed"`, but without this check that status was
  // discarded and every malformed request surfaced as a 500 INTERNAL_ERROR,
  // an inaccurate/misleading signal (a client mistake reported as a server
  // bug) confirmed live before this fix.
  if (err instanceof SyntaxError && (err as SyntaxError & { status?: number; type?: string }).type === "entity.parse.failed") {
    res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
    return;
  }
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
}
