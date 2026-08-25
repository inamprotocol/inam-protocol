/**
 * Minimal canonical JSON serializer: recursively sorts object keys and emits
 * whitespace-free JSON. This is a practical subset of RFC 8785 (JCS) — it does
 * not handle every JCS number-formatting edge case, but it is deterministic
 * for the plain string/number/boolean/array/object shapes used by Inam Protocol's own
 * schemas, which is all that's required for our signer and verifier to agree.
 *
 * Number formatting here (via native `JSON.stringify`) already follows the
 * ECMA-262 `Number::toString` algorithm, which is what
 * sdk-python/inamprotocol/canonical.py's `_format_number` was written to
 * replicate byte-for-byte after a real cross-language signature failure
 * (`score: 1.0` verified in Python, rejected here, because Python's own
 * `json.dumps` renders it "1.0" where this renders it "1"). One gap native
 * `JSON.stringify` has that Python's fix doesn't: `JSON.stringify(NaN)` and
 * `JSON.stringify(Infinity)` both silently produce the string `"null"`
 * rather than erroring, which would corrupt a signature without any error on
 * either side — guarded against explicitly below.
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`Cannot canonicalize non-finite number: ${value}`);
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => JSON.stringify(k) + ":" + stringify(obj[k]));
  return "{" + entries.join(",") + "}";
}
