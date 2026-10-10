/**
 * Web Bot Auth: HTTP Message Signatures (RFC 9421) over an agent's Ed25519 key,
 * in the profile Cloudflare verifies for signed agents
 * (draft-meunier-web-bot-auth-architecture). Lets an origin recognize the
 * caller cryptographically instead of by User-Agent or IP.
 *
 * `Signature-Agent` is sent as a structured-field string, the form Cloudflare
 * requires today; the draft's newer dictionary form is rejected there.
 */
import { didToPublicKey, keypairFromPrivateKey, sign, verifyRawEd25519 } from "./crypto/keys.js";
import { sha256 } from "@noble/hashes/sha256";

export const WEB_BOT_AUTH_TAG = "web-bot-auth";
export const DIRECTORY_TAG = "http-message-signatures-directory";
export const DIRECTORY_PATH = "/.well-known/http-message-signatures-directory";
export const DIRECTORY_CONTENT_TYPE = "application/http-message-signatures-directory+json";

const b64url = (b: Uint8Array) => Buffer.from(b).toString("base64url");

export interface Ed25519Jwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
}

export const ed25519Jwk = (publicKey: Uint8Array): Ed25519Jwk => ({ kty: "OKP", crv: "Ed25519", x: b64url(publicKey) });

/** RFC 7638 / RFC 8037 A.3 JWK thumbprint: base64url sha256 of the required members in lexical order. */
export function jwkThumbprint(publicKey: Uint8Array): string {
  const { crv, kty, x } = ed25519Jwk(publicKey);
  return b64url(sha256(new TextEncoder().encode(JSON.stringify({ crv, kty, x }))));
}

/** JWKS body for `/.well-known/http-message-signatures-directory`. Accepts raw public keys or did:key IDs. */
export function httpMessageSignaturesDirectory(keys: (Uint8Array | string)[]): { keys: Ed25519Jwk[] } {
  return { keys: keys.map((k) => ed25519Jwk(typeof k === "string" ? didToPublicKey(k) : k)) };
}

// sf-string: printable ASCII, with `"` and `\` escaped.
function sfString(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error("webBotAuth: value must be printable ASCII");
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

export interface SignatureOptions {
  /** Unix seconds; default now. */
  created?: number;
  /** Seconds until the signature expires; default 60. */
  expiresIn?: number;
  /** Default: 64 random bytes, base64. */
  nonce?: string;
  /** Signature label; default "sig1". */
  label?: string;
}

/**
 * Signs `components` (name -> value, in order) with RFC 9421 and returns the
 * `Signature-Input` and `Signature` header values.
 */
function signComponents(privateKey: Uint8Array, components: [string, string][], tag: string, opts: SignatureOptions) {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const nonce = opts.nonce ?? Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const keyid = jwkThumbprint(keypairFromPrivateKey(privateKey).publicKey);
  const params =
    `(${components.map(([n]) => n).join(" ")})` +
    `;created=${created};keyid=${sfString(keyid)};alg="ed25519";expires=${created + (opts.expiresIn ?? 60)}` +
    `;nonce=${sfString(nonce)};tag=${sfString(tag)}`;
  const base = [...components.map(([n, v]) => `${n}: ${v}`), `"@signature-params": ${params}`].join("\n");
  const label = opts.label ?? "sig1";
  const signature = Buffer.from(sign(new TextEncoder().encode(base), privateKey)).toString("base64");
  return { "Signature-Input": `${label}=${params}`, Signature: `${label}=:${signature}:` };
}

/**
 * Web Bot Auth request headers for a request to `url`: `Signature-Agent`,
 * `Signature-Input` and `Signature`, covering `@authority` and `signature-agent`.
 * `signatureAgent` is the https origin that serves your key directory.
 */
export function webBotAuthHeaders(
  url: string | URL,
  privateKey: Uint8Array,
  opts: SignatureOptions & { signatureAgent: string },
): Record<"Signature-Agent" | "Signature-Input" | "Signature", string> {
  if (new URL(opts.signatureAgent).protocol !== "https:") throw new Error("webBotAuth: signatureAgent must be an https:// URL");
  const agent = sfString(opts.signatureAgent);
  // URL.host is lowercased with any default port dropped, as RFC 9421 §2.2.3 wants.
  const authority = new URL(url).host;
  return {
    "Signature-Agent": agent,
    ...signComponents(privateKey, [['"@authority"', authority], ['"signature-agent"', agent]], WEB_BOT_AUTH_TAG, opts),
  };
}

/**
 * The signed response for your key directory. Cloudflare requires the
 * directory to be signed by every key it lists, covering the request's
 * `@authority`; this signs with one key. `authority` is the Host the
 * directory was requested on.
 */
export function directoryResponseHeaders(
  authority: string,
  privateKey: Uint8Array,
  opts: SignatureOptions = {},
): Record<"Content-Type" | "Signature-Input" | "Signature", string> {
  return {
    "Content-Type": DIRECTORY_CONTENT_TYPE,
    ...signComponents(privateKey, [['"@authority";req', authority.toLowerCase()]], DIRECTORY_TAG, opts),
  };
}

/**
 * Checks a fetched key directory the way a verifier would: the body is a JWKS
 * of Ed25519 keys, and the response carries an RFC 9421 signature tagged
 * `http-message-signatures-directory`, covering `"@authority";req`, by a key
 * the directory lists (matched by JWK thumbprint), not expired.
 */
export function verifyDirectoryResponse(
  authority: string,
  headers: Headers,
  body: string,
  now = Math.floor(Date.now() / 1000),
): { valid: boolean; keys: number; keyid?: string; reason?: string } {
  let keys: Uint8Array[];
  try {
    keys = (JSON.parse(body).keys ?? []).filter((k: Ed25519Jwk) => k?.kty === "OKP" && k.crv === "Ed25519").map((k: Ed25519Jwk) => new Uint8Array(Buffer.from(k.x, "base64url")));
  } catch {
    return { valid: false, keys: 0, reason: "body is not a JWKS" };
  }
  if (!keys.length) return { valid: false, keys: 0, reason: "no Ed25519 keys" };
  const input = headers.get("signature-input");
  const sigHeader = headers.get("signature");
  if (!input || !sigHeader) return { valid: false, keys: keys.length, reason: "response is not signed" };
  // ponytail: reads the first signature label only; directories carry one per key, the first is enough to show control.
  const m = /^\s*([\w-]+)=(\(([^)]*)\)(.*))$/.exec(input.split(/,(?=\s*[\w-]+=\()/)[0]);
  if (!m) return { valid: false, keys: keys.length, reason: "unreadable Signature-Input" };
  const [, label, params, components, rest] = m;
  const sig = new RegExp(`(?:^|,)[ ]*${label}=:([^:]+):`).exec(sigHeader)?.[1];
  const param = (k: string) => new RegExp(`;${k}=("([^"]*)"|([0-9]+))`).exec(rest)?.slice(2).find((x) => x !== undefined);
  if (!sig) return { valid: false, keys: keys.length, reason: `no Signature for ${label}` };
  if (param("tag") !== DIRECTORY_TAG) return { valid: false, keys: keys.length, reason: `tag is not ${DIRECTORY_TAG}` };
  const expires = param("expires");
  if (expires && Number(expires) < now) return { valid: false, keys: keys.length, reason: "signature expired" };
  const lines: string[] = [];
  for (const c of components.trim().split(/\s+/)) {
    if (c !== '"@authority";req' && c !== '"@authority"') return { valid: false, keys: keys.length, reason: `unsupported component ${c}` };
    lines.push(`${c}: ${authority.toLowerCase()}`);
  }
  const base = new TextEncoder().encode([...lines, `"@signature-params": ${params}`].join("\n"));
  const keyid = param("keyid");
  const signature = new Uint8Array(Buffer.from(sig, "base64"));
  const key = keys.find((k) => jwkThumbprint(k) === keyid);
  if (!key) return { valid: false, keys: keys.length, keyid, reason: "keyid matches no listed key" };
  return verifyRawEd25519(signature, base, key)
    ? { valid: true, keys: keys.length, keyid }
    : { valid: false, keys: keys.length, keyid, reason: "signature does not verify" };
}
