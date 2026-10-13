import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generate } from "../interop/emilia/generate.js";
// @ts-expect-error -- plain .mjs, no types; kept dependency-free on purpose
import { runCases, verifyBinding } from "../interop/emilia/verify.mjs";

const dir = new URL("../interop/emilia/", import.meta.url);

describe("interop/emilia", () => {
  it("verify.mjs passes every case and exits 0", () => {
    const out = execFileSync(process.execPath, [fileURLToPath(new URL("verify.mjs", dir))], { encoding: "utf8" });
    expect(out.match(/^PASS/gm)).toHaveLength(5);
    expect(out).not.toMatch(/^FAIL/m);
  });

  it("generate.ts reproduces the committed fixtures byte for byte", () => {
    for (const [name, text] of Object.entries(generate())) {
      expect(readFileSync(new URL(name, dir), "utf8").replace(/\r\n/g, "\n")).toBe(text);
    }
  });

  it("rejects a tampered signature and a swapped requester", () => {
    const receipt = JSON.parse(readFileSync(new URL("receipt.json", dir), "utf8"));
    const action = JSON.parse(readFileSync(new URL("consequence-admission-lifecycle-v0.1.vectors.json", dir), "utf8")).base_action;
    expect(verifyBinding(receipt, action).accepted).toBe(true);
    const sig = Buffer.from(receipt.signatures.agentA, "base64");
    sig[0] ^= 1;
    expect(verifyBinding({ ...receipt, signatures: { ...receipt.signatures, agentA: sig.toString("base64") } }, action).checks.requesterSignature).toBe(false);
    expect(verifyBinding({ ...receipt, agentA: { ...receipt.agentA, id: receipt.agentB.id } }, action).accepted).toBe(false);
    expect(runCases().every((c: { actual: boolean; expected: boolean }) => c.actual === c.expected)).toBe(true);
  });
});
