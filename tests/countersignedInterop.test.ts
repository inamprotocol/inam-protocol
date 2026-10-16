import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate, REQUESTER_ADDRESS, PROVIDER_ADDRESS } from "../interop/countersigned/generate.js";
import { verifyErc8004Feedback } from "../sdk-js/src/erc8004.js";
import type { InamClient } from "../sdk-js/src/client.js";

const dir = new URL("../interop/countersigned/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("vectors.json", dir), "utf8"));

describe("interop/countersigned", () => {
  it("verify.mjs passes every case and exits 0", () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("verify.mjs", dir))], { encoding: "utf8" });
    expect(out.match(/^PASS/gm)).toHaveLength(vectors.cases.length);
    expect(out).not.toMatch(/^FAIL/m);
  });

  it("generate.ts reproduces the committed vectors byte for byte", () => {
    expect(readFileSync(new URL("vectors.json", dir), "utf8").replace(/\r\n/g, "\n")).toBe(generate()["vectors.json"]);
  });

  // The SDK's verifier and the dependency-free one agree on which cases the on-chain-visible checks reject.
  it("SDK verifyErc8004Feedback agrees with each case", async () => {
    const { requester } = vectors.parties;
    const registry = {
      getAgent: async (id: string) => ({ id, linked: { erc8004_id: id === requester.did ? REQUESTER_ADDRESS : PROVIDER_ADDRESS } }),
      getReceipt: async () => ({ status: "finalized" }),
    } as unknown as InamClient;
    for (const c of vectors.cases) {
      const sdk = await verifyErc8004Feedback(c.feedbackFile, c.onchainEvent, registry);
      // The SDK has no observed bytes, so it cannot see the outputHash binding; every other failure must match.
      const expectSdkValid = c.expected.failedChecks.every((k: string) => k === "outputHashMatchesObservedBytes");
      expect(sdk.valid, `${c.id}: ${sdk.reasons.join("; ")}`).toBe(expectSdkValid);
    }
  });
});
