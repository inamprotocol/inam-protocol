import { z } from "zod";
import { customActionProvider } from "@coinbase/agentkit";

export const DEFAULT_BASE_URL = "https://api.inamprotocol.org";

export type Verdict = "pass" | "caution" | "fail";
export interface InamCheckResult {
  target: string;
  verdict: Verdict;
  checks: { id: string; status: string; label: string; detail?: string }[];
  next?: string;
  payment?: { accepts?: { payTo?: string; price?: string; network?: string }[] };
}
export interface InamOptions {
  /** Hosted check API. Only the target URL or address is sent to it, never payment data. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** GET /v1/check on the INAM registry (SPEC §6). Throws on a non-200 answer or a network error. */
export async function inamCheck(target: string, method: "GET" | "POST" = "GET", o: InamOptions = {}): Promise<InamCheckResult> {
  const q = new URLSearchParams({ target, ...(method === "POST" ? { method } : {}) });
  const res = await (o.fetchImpl ?? fetch)(`${o.baseUrl ?? DEFAULT_BASE_URL}/v1/check?${q}`, { signal: AbortSignal.timeout(o.timeoutMs ?? 20_000) });
  if (!res.ok) throw new Error(`INAM check failed: HTTP ${res.status}`);
  return (await res.json()) as InamCheckResult;
}

/** What an agent needs to decide: the verdict, every non-passing line, and what the seller can do about it. */
export function summarize(r: InamCheckResult) {
  return {
    verdict: r.verdict,
    target: r.target,
    payTo: [...new Set(r.payment?.accepts?.map((a) => a.payTo).filter(Boolean))],
    price: r.payment?.accepts?.[0]?.price,
    concerns: r.checks.filter((c) => c.status === "fail" || c.status === "warn").map((c) => `[${c.status}] ${c.label}`),
    next: r.next,
    guidance:
      r.verdict === "fail" ? "Do not pay this endpoint as it stands." :
      r.verdict === "caution" ? "Nothing failed, but identity signals are missing. Pay only a small amount, or ask the seller to link its payTo wallet to an INAM ID." :
      "No problems found by the public checks. This is not a guarantee about the seller's future behaviour.",
  };
}

const CheckSchema = z.object({
  target: z.string().describe("An x402 endpoint URL (https://...), a 0x EVM wallet address, or a did:key INAM ID"),
  method: z.enum(["GET", "POST"]).optional().describe("Use POST for endpoints that only answer POST"),
});

/** Read-only AgentKit action backed by the free INAM check. Works with any wallet provider. */
export const inamActionProvider = (opts: InamOptions = {}) =>
  customActionProvider([
    {
      name: "inam_check",
      description:
        "Check an x402 endpoint, wallet or INAM ID BEFORE paying it. Returns a pass / caution / fail verdict from public signals: the 402 terms, ERC-8004 identity, INAM wallet link and receipts, Web Bot Auth keys, HTTPS and domain age. Never pays anything. Do not pay when the verdict is fail.",
      schema: CheckSchema,
      invoke: async (args: z.infer<typeof CheckSchema>): Promise<string> => {
        try {
          return JSON.stringify(summarize(await inamCheck(args.target, args.method, opts)));
        } catch (e) {
          // An unreachable checker is "unknown", never "safe".
          return JSON.stringify({ verdict: "unknown", error: e instanceof Error ? e.message : String(e), guidance: "The check could not run. Do not treat this as a pass." });
        }
      },
    },
  ]);

export class InamBlockedError extends Error {
  constructor(readonly result: InamCheckResult | undefined, message: string) {
    super(message);
  }
}
export interface GuardOptions extends InamOptions {
  /** Verdicts that stop the request. Default ["fail"]. */
  block?: Verdict[];
  /** If the check itself cannot run: "block" (default) or "allow". */
  onError?: "block" | "allow";
  /** Verdicts are cached per URL and method. Default 5 minutes. */
  cacheMs?: number;
}

/** Wraps a fetch so every request is checked first. Put it UNDER the payment wrapper:
 *  `wrapFetchWithPayment(inamGuardedFetch(fetch), client)`. Throws InamBlockedError instead of letting a payment go out. */
export function inamGuardedFetch(base: typeof fetch = fetch, g: GuardOptions = {}): typeof fetch {
  const block = new Set<Verdict>(g.block ?? ["fail"]);
  const cache = new Map<string, { at: number; result?: InamCheckResult; error?: string }>();
  return async (input, init) => {
    const req = input instanceof Request ? input : undefined;
    const url = req?.url ?? String(input);
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase() === "POST" ? "POST" : "GET";
    const key = `${method} ${url}`;
    let hit = cache.get(key);
    if (!hit || Date.now() - hit.at > (g.cacheMs ?? 300_000)) {
      hit = { at: Date.now() };
      try {
        hit.result = await inamCheck(url, method, g);
      } catch (e) {
        hit.error = e instanceof Error ? e.message : String(e);
      }
      cache.set(key, hit);
    }
    if (hit.error && (g.onError ?? "block") === "block") throw new InamBlockedError(undefined, `INAM check could not run for ${url}: ${hit.error}`);
    if (hit.result && block.has(hit.result.verdict)) throw new InamBlockedError(hit.result, `INAM check ${hit.result.verdict} for ${url}: ${summarize(hit.result).concerns.join("; ")}`);
    return base(input, init);
  };
}
