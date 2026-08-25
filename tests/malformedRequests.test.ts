import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

// Real HTTP, real Express app -- express.json() runs as global middleware
// before any route or its requireSignedRequest check, so a malformed body
// fails at the body-parsing stage regardless of what's in the auth headers.
// Confirmed live before this fix: a malformed JSON body produced a 500
// INTERNAL_ERROR (an uncaught SyntaxError falling through to the generic
// catch-all in src/middleware/errors.ts), not a 400 -- misleadingly
// reporting a client mistake as a server bug.
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("malformed request bodies", () => {
  it("returns 400 INVALID_JSON, not 500, for a syntactically invalid body", async () => {
    const res = await fetch(`${baseUrl}/v1/agents`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "inam-agent": "did:key:zTestPlaceholder",
        "inam-timestamp": String(Date.now()),
        "inam-signature": "irrelevant-body-parsing-fails-first",
        "idempotency-key": "malformed-json-test",
      },
      body: "{invalid json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_JSON");
  });
});
