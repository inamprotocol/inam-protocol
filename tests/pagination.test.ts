import { createHash } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { registerAgent } from "../src/services/agentService.js";
import * as jobService from "../src/services/jobService.js";
import { generateKeypair } from "../sdk-js/src/crypto/keys.js";

// Round-2 audit item 7: neither /jobs/search nor /agents/search bounded
// their result set at all. Reproduces >limit results and asserts the page
// shape (default, custom, clamp, offset, hasMore).

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = createServer().listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("GET /jobs/search pagination", () => {
  const capability = `pagination.test.${crypto.randomUUID()}`;

  beforeAll(() => {
    const poster = generateKeypair();
    registerAgent(poster.did, { capabilities: ["job.posting"] });
    for (let i = 0; i < 55; i++) {
      jobService.postJob(poster.did, { capability, specHash: `sha256:${createHash("sha256").update(`job${i}`).digest("hex")}` });
    }
  });

  it("defaults to 50 results with hasMore true", async () => {
    const res = await fetch(`${baseUrl}/v1/jobs/search?capability=${capability}`);
    const body = (await res.json()) as { jobs: unknown[]; hasMore: boolean };
    expect(body.jobs.length).toBe(50);
    expect(body.hasMore).toBe(true);
  });

  it("returns the remainder on the next page with hasMore false", async () => {
    const res = await fetch(`${baseUrl}/v1/jobs/search?capability=${capability}&offset=50`);
    const body = (await res.json()) as { jobs: unknown[]; hasMore: boolean };
    expect(body.jobs.length).toBe(5);
    expect(body.hasMore).toBe(false);
  });

  it("clamps an oversized limit to the max page size", async () => {
    const res = await fetch(`${baseUrl}/v1/jobs/search?capability=${capability}&limit=99999`);
    const body = (await res.json()) as { jobs: unknown[]; hasMore: boolean };
    expect(body.jobs.length).toBe(55);
    expect(body.hasMore).toBe(false);
  });

  it("ignores a garbage limit/offset and falls back to defaults", async () => {
    const res = await fetch(`${baseUrl}/v1/jobs/search?capability=${capability}&limit=not-a-number&offset=-5`);
    const body = (await res.json()) as { jobs: unknown[]; hasMore: boolean };
    expect(body.jobs.length).toBe(50);
    expect(body.hasMore).toBe(true);
  });
});

describe("GET /agents/search pagination", () => {
  const capability = `pagination.agent.test.${crypto.randomUUID()}`;

  beforeAll(() => {
    for (let i = 0; i < 12; i++) {
      registerAgent(generateKeypair().did, { capabilities: [capability] });
    }
  });

  it("respects a custom limit and reports hasMore correctly", async () => {
    const res = await fetch(`${baseUrl}/v1/agents/search?capability=${capability}&limit=10`);
    const body = (await res.json()) as { agents: unknown[]; hasMore: boolean };
    expect(body.agents.length).toBe(10);
    expect(body.hasMore).toBe(true);

    const next = await fetch(`${baseUrl}/v1/agents/search?capability=${capability}&limit=10&offset=10`);
    const nextBody = (await next.json()) as { agents: unknown[]; hasMore: boolean };
    expect(nextBody.agents.length).toBe(2);
    expect(nextBody.hasMore).toBe(false);
  });
});
