import { describe, it, expect, vi } from "vitest";
import { inamActionProvider, inamGuardedFetch, InamBlockedError, summarize, type InamCheckResult } from "./index.js";

const result = (verdict: InamCheckResult["verdict"]): InamCheckResult => ({
  target: "https://seller.example/api", verdict,
  checks: [{ id: "tls", status: "pass", label: "HTTPS" }, { id: "inam.link", status: "warn", label: "payTo not linked to any INAM ID" }],
  payment: { accepts: [{ payTo: "0xabc", price: "0.01 USD Coin", network: "eip155:8453" }] },
  next: "Start with a small payment.",
});
const checker = (r: InamCheckResult | number) =>
  vi.fn(async () => (typeof r === "number" ? new Response("x", { status: r }) : new Response(JSON.stringify(r), { status: 200 })));
const asFetch = (f: unknown) => f as typeof fetch;

describe("@inamprotocol/agentkit", () => {
  it("exposes inam_check as an AgentKit action and returns a compact summary", async () => {
    const f = checker(result("caution"));
    const [action] = inamActionProvider({ fetchImpl: asFetch(f) }).getActions({} as never);
    expect(action.name).toMatch(/inam_check$/);
    const out = JSON.parse(await action.invoke({ target: "https://seller.example/api", method: "POST" }));
    expect(out).toMatchObject({ verdict: "caution", payTo: ["0xabc"], concerns: ["[warn] payTo not linked to any INAM ID"] });
    expect(String(f.mock.calls[0][0])).toContain("method=POST");
  });

  it("reports an unreachable checker as unknown, never as a pass", async () => {
    const [action] = inamActionProvider({ fetchImpl: asFetch(checker(503)) }).getActions({} as never);
    expect(JSON.parse(await action.invoke({ target: "https://x.example" })).verdict).toBe("unknown");
  });

  it("guard blocks fail before the payment fetch runs, passes caution, and caches", async () => {
    const base = vi.fn(async () => new Response("ok"));
    const f = checker(result("fail"));
    const guarded = inamGuardedFetch(asFetch(base), { fetchImpl: asFetch(f) });
    await expect(guarded("https://seller.example/api")).rejects.toBeInstanceOf(InamBlockedError);
    expect(base).not.toHaveBeenCalled();
    await expect(guarded("https://seller.example/api")).rejects.toThrow(/fail/);
    expect(f).toHaveBeenCalledTimes(1);

    await inamGuardedFetch(asFetch(base), { fetchImpl: asFetch(checker(result("caution"))) })("https://seller.example/api");
    expect(base).toHaveBeenCalledTimes(1);
    const strict = inamGuardedFetch(asFetch(base), { block: ["fail", "caution"], fetchImpl: asFetch(checker(result("caution"))) });
    await expect(strict("https://seller.example/api")).rejects.toBeInstanceOf(InamBlockedError);
  });

  it("guard fails closed when the checker is down unless told otherwise", async () => {
    const base = vi.fn(async () => new Response("ok"));
    const down = asFetch(checker(500));
    await expect(inamGuardedFetch(asFetch(base), { fetchImpl: down })("https://s.example")).rejects.toThrow(/could not run/);
    await inamGuardedFetch(asFetch(base), { fetchImpl: down, onError: "allow" })("https://s.example");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("summarize gives guidance per verdict", () => {
    expect(summarize(result("fail")).guidance).toMatch(/Do not pay/);
    expect(summarize(result("pass")).guidance).toMatch(/not a guarantee/);
  });
});
