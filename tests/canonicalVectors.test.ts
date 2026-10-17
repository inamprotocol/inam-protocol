import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../sdk-js/src/crypto/keys.js";
import { canonicalize } from "../sdk-js/src/crypto/canonical.js";

const { vectors } = JSON.parse(readFileSync(new URL("../interop/canonical/vectors.json", import.meta.url), "utf8")) as {
  vectors: { name: string; input: unknown; canonical: string; utf8Sha256: string }[];
};

describe("canonical JSON non-BMP vectors (shared with the Python SDK)", () => {
  it.each(vectors.map((v) => [v.name, v] as const))("%s", (_n, v) => {
    const out = canonicalize(v.input);
    expect(out).toBe(v.canonical);
    expect(sha256Hex(new TextEncoder().encode(out))).toBe(v.utf8Sha256);
  });
});
