import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { InamClient } from "../sdk-js/src/client.js";
import { generateKeypair } from "../sdk-js/src/crypto/keys.js";
import { inamFetch, inamReceipts, INAM_RECEIPT_HEADER } from "../sdk-js/src/http.js";

// SPEC.md §15: receipts over HTTP, end to end against a real registry.
let server: Server;
let worker: InamClient;
let requester: InamClient;

beforeAll(async () => {
  const app = createServer();
  await new Promise<void>((resolve) => {
    server = app.listen(0, resolve);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  worker = new InamClient(baseUrl, generateKeypair());
  requester = new InamClient(baseUrl, generateKeypair());
  await worker.registerAgent(["code-review"]);
  await requester.registerAgent(["code-review"]);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const review = async (req: Request) =>
  req.method === "POST" ? new Response(`reviewed ${(await req.text()).length} bytes`, { headers: { "content-type": "text/plain" } }) : new Response("no", { status: 405 });

function setup(opts: { tamper?: boolean; accept?: () => boolean } = {}) {
  const handler = inamReceipts(review, { client: worker, capability: "code-review" });
  const errors: unknown[] = [];
  const inam = inamFetch(requester, {
    fetch: (async (req: Request) => {
      const res = await handler(req);
      return opts.tamper ? new Response("something else", { status: res.status, headers: res.headers }) : res;
    }) as typeof fetch,
    accept: opts.accept,
    onError: (e) => errors.push(e),
  });
  return { inam, errors };
}

describe("receipts over HTTP (SPEC.md §15)", () => {
  it("finalizes a receipt both sides signed for the exact request and response", async () => {
    const { inam, errors } = setup();
    const res = await inam.fetch("https://reviewer.example/review?pr=7", { method: "POST", body: "diff --git a b" });
    expect(await res.text()).toBe("reviewed 14 bytes");
    const id = res.headers.get(INAM_RECEIPT_HEADER)!;
    await inam.settle();
    expect(errors).toEqual([]);
    const receipt = await requester.getReceipt(id);
    expect(receipt.status).toBe("finalized");
    expect(receipt.agentA.id).toBe(requester.did);
    expect(receipt.agentB.id).toBe(worker.did);
    expect(receipt.task.capability).toBe("code-review");
  });

  it("does not countersign when the bytes received differ from what the worker hashed", async () => {
    const { inam, errors } = setup({ tamper: true });
    const res = await inam.fetch("https://reviewer.example/review", { method: "POST", body: "x" });
    await inam.settle();
    expect(String(errors[0])).toMatch(/outputHash/);
    expect((await requester.getReceipt(res.headers.get(INAM_RECEIPT_HEADER)!)).status).toBe("draft");
  });

  it("leaves the draft unsigned when the caller's own check rejects the output", async () => {
    const { inam, errors } = setup({ accept: () => false });
    const res = await inam.fetch("https://reviewer.example/review", { method: "POST", body: "x" });
    await inam.settle();
    expect(errors).toEqual([]);
    expect((await requester.getReceipt(res.headers.get(INAM_RECEIPT_HEADER)!)).status).toBe("draft");
  });

  it("drafts nothing for errors or for callers that don't name themselves", async () => {
    const { inam } = setup();
    expect((await inam.fetch("https://reviewer.example/review")).headers.get(INAM_RECEIPT_HEADER)).toBeNull();
    const handler = inamReceipts(review, { client: worker, capability: "code-review" });
    expect((await handler(new Request("https://reviewer.example/review", { method: "POST", body: "x" }))).headers.get(INAM_RECEIPT_HEADER)).toBeNull();
    const spoofed = new Request("https://reviewer.example/review", { method: "POST", body: "x", headers: { "INAM-Requester": "not-a-did" } });
    expect((await handler(spoofed)).headers.get(INAM_RECEIPT_HEADER)).toBeNull();
  });
});
