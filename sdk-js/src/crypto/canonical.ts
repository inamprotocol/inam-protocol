/**
 * Minimal canonical JSON serializer: recursively sorts object keys and emits
 * whitespace-free JSON. This is a practical subset of RFC 8785 (JCS) — it does
 * not handle every JCS number-formatting edge case, but it is deterministic
 * for the plain string/number/boolean/array/object shapes used by Inam Protocol's own
 * schemas, which is all that's required for our signer and verifier to agree.
 */
export function canonicalize(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
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
