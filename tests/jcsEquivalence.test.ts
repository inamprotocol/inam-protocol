import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import jcs from "canonicalize";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";

// SPEC.md §4.2: for I-JSON input (RFC 7493: no lone surrogates, finite numbers), canonical() is
// byte-identical to RFC 8785. Checked against erdtman/canonicalize, the JavaScript implementation
// RFC 8785 lists. The one difference: canonical() escapes a lone surrogate, RFC 8785 rejects it.

// RFC 8785 Appendix B: IEEE 754 bit pattern -> serialization.
const APPENDIX_B: Array<[string, string]> = [
  ["0000000000000000", "0"], ["8000000000000000", "0"],
  ["0000000000000001", "5e-324"], ["8000000000000001", "-5e-324"],
  ["7fefffffffffffff", "1.7976931348623157e+308"], ["ffefffffffffffff", "-1.7976931348623157e+308"],
  ["4340000000000000", "9007199254740992"], ["c340000000000000", "-9007199254740992"],
  ["4430000000000000", "295147905179352830000"],
  ["44b52d02c7e14af5", "9.999999999999997e+22"], ["44b52d02c7e14af6", "1e+23"], ["44b52d02c7e14af7", "1.0000000000000001e+23"],
  ["444b1ae4d6e2ef4e", "999999999999999700000"], ["444b1ae4d6e2ef4f", "999999999999999900000"], ["444b1ae4d6e2ef50", "1e+21"],
  ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"], ["3eb0c6f7a0b5ed8d", "0.000001"],
  ["41b3de4355555553", "333333333.3333332"], ["41b3de4355555554", "333333333.33333325"], ["41b3de4355555555", "333333333.3333333"],
  ["41b3de4355555556", "333333333.3333334"], ["41b3de4355555557", "333333333.33333343"],
  ["becbf647612f3696", "-0.0000033333333333333333"], ["43143ff3c1cb0959", "1424953923781206.2"],
];
const fromBits = (hex: string) => Buffer.from(hex, "hex").readDoubleBE(0);

// Deterministic PRNG (mulberry32) so a failure reproduces.
function rng(seed: number) {
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const CHARS = ["a", "B", "0", "é", "日", "\u{1F600}", "\u{10000}", "￿", "", "\u0000", "\"", "\\", "\n", " ", "\u007F"];

function randomValue(r: () => number, depth: number): unknown {
  const pick = r();
  if (depth > 3 || pick < 0.3) {
    const k = Math.floor(r() * 5);
    if (k === 0) { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(r() * 2 ** 32)); b.writeUInt32BE(Math.floor(r() * 2 ** 32), 4); const d = b.readDoubleBE(0); return Number.isFinite(d) ? d : 1.5; }
    if (k === 1) return Math.floor(r() * 1e6) - 5e5;
    if (k === 2) return r() < 0.5;
    if (k === 3) return null;
    return Array.from({ length: Math.floor(r() * 6) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("");
  }
  if (pick < 0.6) return Array.from({ length: Math.floor(r() * 4) }, () => randomValue(r, depth + 1));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 5); i > 0; i--) o[Array.from({ length: 1 + Math.floor(r() * 3) }, () => CHARS[Math.floor(r() * CHARS.length)]).join("")] = randomValue(r, depth + 1);
  return o;
}

describe("canonical() vs RFC 8785 (erdtman/canonicalize)", () => {
  it("RFC 8785 Appendix B numbers", () => {
    for (const [bits, expected] of APPENDIX_B) {
      expect(canonicalize(fromBits(bits)), bits).toBe(expected);
      expect(jcs(fromBits(bits)), bits).toBe(expected);
    }
  });

  it("every shared canonical vector, except the lone-surrogate one", () => {
    const { vectors } = JSON.parse(readFileSync(new URL("../interop/canonical/vectors.json", import.meta.url), "utf8")) as { vectors: { name: string; input: unknown; canonical: string }[] };
    for (const v of vectors) {
      if (v.name === "lone-surrogates-escaped") {
        expect(() => jcs(v.input)).toThrow(/surrogate/i); // not I-JSON: RFC 8785 rejects, canonical() escapes
        continue;
      }
      expect(jcs(v.input), v.name).toBe(v.canonical);
    }
  });

  it("the signed content of every interop fixture receipt", () => {
    const strip = ({ signatures, status, dispute, visibility, ...signed }: Record<string, unknown>) => signed;
    const files = ["emilia/receipt.json", "emilia/receipt-caid.json"].map((f) => JSON.parse(readFileSync(new URL(`../interop/${f}`, import.meta.url), "utf8")));
    const cs = JSON.parse(readFileSync(new URL("../interop/countersigned/vectors.json", import.meta.url), "utf8"));
    for (const c of cs.cases) {
      const file = JSON.parse(c.feedbackFile);
      files.push(file.inam.receipt);
      expect(canonicalize(file)).toBe(jcs(file)); // the ERC-8004 feedback file itself
    }
    expect(files.length).toBe(2 + cs.cases.length);
    for (const r of files) expect(canonicalize(strip(r))).toBe(jcs(strip(r)));
  });

  it("20,000 random I-JSON values (random doubles, astral/BMP/control keys, nesting)", () => {
    const r = rng(8785);
    for (let i = 0; i < 20000; i++) {
      const v = randomValue(r, 0);
      expect(canonicalize(v)).toBe(jcs(v));
    }
  });
});
