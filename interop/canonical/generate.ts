// Regenerates vectors.json: canonical-JSON cases with non-ASCII and non-BMP content.
//   npx tsx interop/canonical/generate.ts
// sdk-js/src/crypto/canonical.ts is the reference. Every SDK must reproduce `canonical` exactly
// (tests/canonicalVectors.test.ts, sdk-python/tests/test_canonical_vectors.py).
// JS sorts keys by UTF-16 code unit, so "\u{1F600}" (D83D...) sorts BEFORE "￿"; code-point order does the opposite.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sha256 } from "@noble/hashes/sha256";
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";

const cases: Array<[string, unknown]> = [
  ["astral-key-sorts-before-U+FFFF", { "￿": 1, "\u{1F600}": 2 }],
  ["astral-key-sorts-before-U+E000", { "": "private-use", "\u{10000}": "linear-b", a: 0 }],
  ["astral-keys-among-bmp-keys", { z: 1, "\u{1D11E}": 2, "é": 3, "日本": 4, A: 5, "Ａ": 6 }],
  ["astral-key-nested-in-array", { list: [{ "�": 1, "\u{1F680}": 2 }, [{ "\u{20000}": "cjk-ext-b", "￯": "x" }]] }],
  ["emoji-values", { a: "\u{1F600}", b: "\u{1F468}‍\u{1F469}‍\u{1F467}", c: "\u{1F1F9}\u{1F1F7}", d: "\u{1D11E} clef" }],
  ["bmp-non-ascii", { name: "Café", jp: "日本語", tr: "ğüşıöç İ" }],
  ["no-unicode-normalization", { nfc: "é", nfd: "é" }],
  ["lone-surrogates-escaped", { hi: "\uD800", lo: "\uDC00", rev: "\uDC00\uD800", "\uD83D": "key" }],
  ["control-and-special-chars", { c: "\u0000\u0008\u0009\u000A\u000C\u000D\u001F", q: "\"\/", del: "\u007F", ls: "  " }],
  ["key-order-digits-case-accents", { b: 1, B: 2, 10: 3, 9: 4, "é": 5, e: 6, "": 7 }],
];

const vectors = cases.map(([name, input]) => {
  const canonical = canonicalize(input);
  return { name, input, canonical, utf8Sha256: Buffer.from(sha256(new TextEncoder().encode(canonical))).toString("hex") };
});

writeFileSync(fileURLToPath(new URL("vectors.json", import.meta.url)), JSON.stringify({ description: "Canonical JSON vectors with non-ASCII and non-BMP content; reference: sdk-js/src/crypto/canonical.ts", vectors }, null, 2) + "\n");
