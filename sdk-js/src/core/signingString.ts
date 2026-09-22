/**
 * Request-signing string templates, shared by both runtimes' verification
 * middleware and this SDK's client. Round-2 sub-finding-7: the v1 string had
 * no host/domain component, so a signature minted for one hostname verified
 * equally well against any other host serving the same code (the Worker is
 * dual-hosted -- a custom domain plus its *.workers.dev fallback -- and the
 * same is true of any other deployment of this open-source registry).
 *
 * v2 adds the host. The signer includes the host it believes it is talking
 * to (derived from its own configured base URL, so it costs callers nothing
 * extra to configure); the *server* always plugs in its own actual incoming
 * Host header when recomputing this string for verification -- never a
 * client-supplied value -- so a captured v2-signed request cannot be
 * replayed against a different host: the recomputed string won't match what
 * was signed.
 *
 * Migration: v1 (no `inam-sig-version` header) is still accepted by both
 * runtimes' verification middleware so already-deployed callers on an older
 * SDK version keep working. New SDK versions always sign v2. v1 acceptance
 * is deprecated as of SPEC.md v0.28 and will be removed in a future
 * version, not this one.
 */
export const SIG_VERSION_HEADER = "inam-sig-version";
export const CURRENT_SIG_VERSION = "2";

export function buildSigningStringV1(method: string, path: string, timestamp: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${timestamp}\n${bodyHash}`;
}

export function buildSigningStringV2(method: string, path: string, host: string, timestamp: string, bodyHash: string): string {
  return `${method.toUpperCase()}\n${path}\n${host}\n${timestamp}\n${bodyHash}`;
}
