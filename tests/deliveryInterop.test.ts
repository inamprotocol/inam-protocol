import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate } from "../interop/delivery/generate.js";
// @ts-expect-error -- plain .mjs, no types; kept dependency-free on purpose
import { read } from "../interop/delivery/verify.mjs";
import { registerAgent } from "../src/services/agentService.js";
import { createDraft, countersign } from "../src/services/receiptService.js";
import { computeReputation } from "../src/services/reputationService.js";

const dir = new URL("../interop/delivery/", import.meta.url);
const vectors = JSON.parse(readFileSync(new URL("vectors.json", dir), "utf8"));
const byId = (id: string) => vectors.cases.find((c: { id: string }) => c.id === id).receipt;

describe("interop/delivery", () => {
  it("verify.mjs passes every case and exits 0", () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("verify.mjs", dir))], { encoding: "utf8" });
    expect(out.match(/^PASS/gm)).toHaveLength(3);
    expect(out).not.toMatch(/^FAIL/m);
  });

  it("generate.ts reproduces the committed vectors byte for byte", () => {
    expect(readFileSync(new URL("vectors.json", dir), "utf8").replace(/\r\n/g, "\n")).toBe(generate()["vectors.json"]);
  });

  it("a flipped seller signature or edited content is invalid, not a weaker verdict", () => {
    const r = byId("VALID-COUNTERSIGNED");
    const sig = Buffer.from(r.signatures.agentB, "base64");
    sig[0] ^= 1;
    expect(read({ ...r, signatures: { ...r.signatures, agentB: sig.toString("base64") } }, vectors.observed).verdict).toBe("invalid");
    expect(read({ ...r, task: { ...r.task, capability: "other" } }, vectors.observed).verdict).toBe("invalid");
  });

  it("the reference registry agrees: the draft does not count, the countersigned receipt does", () => {
    const r = byId("VALID-COUNTERSIGNED");
    registerAgent(r.agentB.id, { capabilities: ["data.report"] });
    registerAgent(r.agentA.id, { capabilities: ["job.posting"] });
    const { signatures, status, receiptVersion, receiptId, agentA, agentB, dispute, visibility, ...content } = byId("SELLER-ONLY-DRAFT");
    const stored = createDraft(agentB.id, { ...content, agentAId: agentA.id, signature: signatures.agentB });
    expect(stored.receiptId).toBe(r.receiptId); // same content: the draft and the finalized receipt are one receipt
    expect(computeReputation(agentB.id).components.verifiedReceipts).toBe(0);
    expect(countersign(receiptId, agentA.id, r.signatures.agentA).status).toBe("finalized");
    expect(computeReputation(agentB.id).components.verifiedReceipts).toBe(1);
  });
});
