import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/crypto/canonical.js";

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
});
