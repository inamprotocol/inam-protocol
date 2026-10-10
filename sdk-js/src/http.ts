/**
 * Receipts over HTTP (SPEC.md §15): every call between two agents leaves a
 * countersigned receipt, with one wrapper on each side.
 *
 * Worker (the agent that does the work and answers the call):
 *
 *   const handler = inamReceipts(myHandler, { client, capability: "code-review" });
 *
 * Requester (the agent that calls it):
 *
 *   const inam = inamFetch(client);
 *   const res = await inam.fetch("https://reviewer.example/review", { method: "POST", body });
 *   await inam.settle(); // wait for countersigns before a serverless function exits
 *
 * The requester names itself in `INAM-Requester`. The worker hashes the request
 * it received and the response it sends, drafts a receipt naming the requester,
 * and returns the receipt id in `INAM-Receipt`. The requester recomputes both
 * hashes from the bytes it actually sent and received, and countersigns only
 * when they match. A countersign confirms delivery of exactly those bytes for
 * exactly that request, nothing more; pass `accept` to also judge the output.
 */
import type { InamClient } from "./client.js";
import { computeReceiptId, type ReceiptContentInput } from "./core/receiptContent.js";
import { sha256Hex } from "./crypto/keys.js";
import type { ExecutionReceipt } from "./types.js";

export const INAM_REQUESTER_HEADER = "INAM-Requester";
export const INAM_RECEIPT_HEADER = "INAM-Receipt";

const DID_KEY = /^did:key:z[1-9A-HJ-NP-Za-km-z]+$/;

/** sha256 over `METHOD path?query\n` followed by the exact request body bytes. */
export function httpSpecHash(method: string, url: string, body: Uint8Array): string {
  const { pathname, search } = new URL(url);
  const head = new TextEncoder().encode(`${method.toUpperCase()} ${pathname}${search}\n`);
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head);
  bytes.set(body, head.length);
  return `sha256:${sha256Hex(bytes)}`;
}

/** sha256 over the exact response body bytes. */
export function httpOutputHash(body: Uint8Array): string {
  return `sha256:${sha256Hex(body)}`;
}

const bytesOf = async (r: Request | Response) => new Uint8Array(await r.clone().arrayBuffer());

/**
 * Wraps a fetch-style handler (Workers, Hono, Next.js route handlers, Deno,
 * Bun). Drafts a receipt for every 2xx answer to a request that carries a
 * valid `INAM-Requester`; anything else passes through untouched. Buffers the
 * response body to hash it, so it is not for long-lived streams.
 */
export function inamReceipts(
  handler: (req: Request) => Response | Promise<Response>,
  opts: {
    client: InamClient;
    capability: string;
    visibility?: "public" | "participants_only";
    /** Run the registry call in the background (e.g. ctx.waitUntil); default: await it before responding. */
    waitUntil?: (p: Promise<unknown>) => void;
    onError?: (err: unknown) => void;
  },
): (req: Request) => Promise<Response> {
  return async (req) => {
    const requester = req.headers.get(INAM_REQUESTER_HEADER);
    if (!requester || !DID_KEY.test(requester) || requester === opts.client.did) return handler(req);

    const reqBytes = await bytesOf(req);
    const res = await handler(req);
    if (!res.ok) return res;

    const now = new Date().toISOString();
    const input: ReceiptContentInput = {
      jobId: `http:${crypto.randomUUID()}`,
      task: { capability: opts.capability, specHash: httpSpecHash(req.method, req.url, reqBytes), createdAt: now },
      result: { outputHash: httpOutputHash(await bytesOf(res)), completedAt: now },
      verification: { method: "payer_confirmation", outcome: "success" },
    };
    // Content-addressed, so the id is known before the registry sees the draft.
    const receiptId = computeReceiptId(requester, opts.client.did, input);
    const draft = opts.client.submitWork(requester, input, { visibility: opts.visibility }).catch((err) => opts.onError?.(err));
    if (opts.waitUntil) opts.waitUntil(draft);
    else await draft;

    const headers = new Headers(res.headers);
    headers.set(INAM_RECEIPT_HEADER, receiptId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };
}

/**
 * A fetch that asks the worker for a receipt and countersigns it once the
 * hashes match what was really sent and received. Countersigning runs in the
 * background; `settle()` waits for all of it.
 */
export function inamFetch(
  client: InamClient,
  opts: {
    fetch?: typeof fetch;
    /** Return false to leave the draft unsigned (e.g. the output failed your own checks). */
    accept?: (res: Response, receipt: ExecutionReceipt) => boolean | Promise<boolean>;
    onReceipt?: (receipt: ExecutionReceipt) => void;
    onError?: (err: unknown) => void;
    /** How long to wait for a background-drafted receipt to appear. */
    retries?: number;
    /**
     * Opt in to Web Bot Auth (RFC 9421 signatures, as verified by Cloudflare):
     * every request is signed with this client's key. `signatureAgent` is the
     * https origin serving your key directory (`client.webBotAuthDirectory`).
     */
    webBotAuth?: { signatureAgent: string; expiresIn?: number };
  } = {},
): { fetch: typeof fetch; settle: () => Promise<void> } {
  const base = opts.fetch ?? fetch;
  const pending = new Set<Promise<void>>();

  async function countersign(req: Request, reqBytes: Uint8Array, res: Response, receiptId: string) {
    const specHash = httpSpecHash(req.method, req.url, reqBytes);
    const outputHash = httpOutputHash(await bytesOf(res));
    let receipt: ExecutionReceipt | undefined;
    for (let i = 0; ; i++) {
      try {
        receipt = await client.getReceipt(receiptId);
        break;
      } catch (err) {
        if (i >= (opts.retries ?? 5)) throw err;
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    }
    if (receipt.task.specHash !== specHash) throw new Error(`inamFetch: receipt ${receiptId} names a different request (specHash mismatch)`);
    if (receipt.status !== "draft") return;
    if (opts.accept && !(await opts.accept(res.clone(), receipt))) return;
    // acceptWork also refuses unless this client is the receipt's requester.
    const done = await client.acceptWork(receipt, { jobId: receipt.jobId, outputHash });
    opts.onReceipt?.(done);
  }

  const wrapped = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    req.headers.set(INAM_REQUESTER_HEADER, client.did);
    if (opts.webBotAuth) {
      for (const [k, v] of Object.entries(client.webBotAuthHeaders(req.url, opts.webBotAuth))) req.headers.set(k, v);
    }
    const reqBytes = await bytesOf(req);
    const res = await base(req);
    const receiptId = res.headers.get(INAM_RECEIPT_HEADER);
    if (res.ok && receiptId) {
      const p = countersign(req, reqBytes, res.clone(), receiptId).catch((err) => opts.onError?.(err));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
    return res;
  }) as typeof fetch;

  return {
    fetch: wrapped,
    settle: async () => {
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
