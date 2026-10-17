import { describe, expect, it } from "vitest";
import { generateKeypair } from "../sdk-js/src/index.js";
import { selfCheck, signCheckoutRequest, verifyCheckoutRequest } from "../examples/acp-agent-signature.js";

describe("examples/acp-agent-signature", () => {
  it("self-check passes", () => {
    expect(() => selfCheck()).not.toThrow();
  });
  it("a request signed by one key does not verify under another key's DID", () => {
    const a = generateKeypair();
    const b = generateKeypair();
    const req = signCheckoutRequest(a, [{ id: "x", quantity: 1 }]);
    expect(verifyCheckoutRequest(req)).toEqual({ ok: true, did: a.did });
    const swapped = { ...req, body: { ...req.body, agent_identity: { did: b.did } } };
    expect(verifyCheckoutRequest(swapped).ok).toBe(false);
  });
});
