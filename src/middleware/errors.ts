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
  console.error(err);
  res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
}
