import { describe, expect, it } from "vitest";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";

describe("canonicalize", () => {
  it("produces the same output regardless of key insertion order", () => {
    const a = canonicalize({ b: 1, a: 2, c: { z: 1, y: 2 } });
    const b = canonicalize({ c: { y: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it("drops undefined-valued keys instead of emitting them", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it("preserves array order (arrays are not sorted)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("is sensitive to any value change", () => {
    const a = canonicalize({ amount: "12.50" });
    const b = canonicalize({ amount: "12.51" });
    expect(a).not.toBe(b);
  });

  // Mirrors sdk-python/tests/test_canonical.py's JS_NUMBER_VECTORS exactly —
  // this is the regression guard for a real, live cross-language signature
  // bug: a Verification submitted with `score: 1.0` from the Python SDK
  // failed INVALID_VERIFICATION_SIGNATURE against this (always-TypeScript)
  // server, because Python's own json.dumps(1.0) produced "1.0" while this
  // side's JSON.stringify(1.0) produces "1". sdk-python/inamprotocol/
  // canonical.py's _format_number now reimplements this side's number
  // formatting exactly instead of trusting Python's own repr rules — these
  // vectors are the two sides' shared source of truth for what "matching"
  // means, checked independently in each language.
  const NUMBER_VECTORS: Array<[number, string]> = [
    [1.0, "1"],
    [0.0, "0"],
    [-0.0, "0"],
    [0.000001, "0.000001"],
    [0.0000001, "1e-7"],
    [1e20, "100000000000000000000"],
    [100.0, "100"],
    [0.99, "0.99"],
    [-1.5, "-1.5"],
    [123456789.123, "123456789.123"],
    [1, "1"],
  ];

  it.each(NUMBER_VECTORS)("formats %j as %j", (value, expected) => {
    expect(canonicalize(value)).toBe(expected);
  });

  it("formats score: 1.0 as 1, not 1.0 — the exact live-reproduced case", () => {
    expect(canonicalize({ score: 1.0 })).toBe('{"score":1}');
  });

  it("rejects NaN and Infinity instead of silently emitting null", () => {
    expect(() => canonicalize(NaN)).toThrow();
    expect(() => canonicalize(Infinity)).toThrow();
    expect(() => canonicalize(-Infinity)).toThrow();
    expect(() => canonicalize({ score: NaN })).toThrow();
  });
});
