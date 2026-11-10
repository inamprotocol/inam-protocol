// @noble/curves is an sdk-js dependency, not a root one; import it from there rather than add a dependency.
import { secp256k1 } from "../../sdk-js/node_modules/@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "node:crypto";
import { ethAddressFromUncompressedPublicKey } from "../../sdk-js/src/crypto/secp256k1.js";
import { sha256Hex } from "../../sdk-js/src/index.js";
import type { Job, Rail } from "./payOnProof.js";

/** USDC over x402 ("exact" scheme, EIP-3009 transferWithAuthorization) as a pay-on-proof rail.
 *
 *   hold    the buyer signs a transferWithAuthorization for the job amount to `payTo` and keeps it.
 *           Nothing is submitted, so nothing moves.
 *   capture POST the payload to the facilitator's /verify, then /settle. The facilitator submits it on-chain.
 *   void    discard the payload. It is never settled and expires at validBefore.
 *
 * The hold ref is `<network>:<EIP-3009 nonce>`, so settlement.paymentRef is `x402:eip155:84532:0x<nonce>`.
 * The receipt is countersigned before settle, so it cannot name the tx hash; the nonce is on-chain
 * too (authorizationState(from, nonce), AuthorizationUsed event). The tx hash is the capture id.
 * https://github.com/coinbase/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md */

export const BASE_SEPOLIA = {
  network: "eip155:84532",
  chainId: 84532,
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  name: "USDC", // the token's EIP-712 domain name/version on Base Sepolia (Base mainnet is "USD Coin")
  version: "2",
  decimals: 6,
};
export type X402Network = typeof BASE_SEPOLIA;

export interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }

const utf8 = (s: string) => new TextEncoder().encode(s);
const word = (v: bigint) => Buffer.from(v.toString(16).padStart(64, "0"), "hex");
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const DOMAIN_TYPE = keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
const TRANSFER_TYPE = keccak_256(utf8("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"));

export const domainSeparator = (n: X402Network) =>
  keccak_256(Buffer.concat([DOMAIN_TYPE, keccak_256(utf8(n.name)), keccak_256(utf8(n.version)), word(BigInt(n.chainId)), word(BigInt(n.asset))]));

/** EIP-712 digest of a transferWithAuthorization. */
export function transferDigest(n: X402Network, a: Authorization): Uint8Array {
  const struct = keccak_256(Buffer.concat([TRANSFER_TYPE, word(BigInt(a.from)), word(BigInt(a.to)), word(BigInt(a.value)), word(BigInt(a.validAfter)), word(BigInt(a.validBefore)), word(BigInt(a.nonce))]));
  return keccak_256(Buffer.concat([Uint8Array.of(0x19, 0x01), domainSeparator(n), struct]));
}

export const addressOf = (privateKey: Uint8Array) => ethAddressFromUncompressedPublicKey(secp256k1.getPublicKey(privateKey, false));

function toAtomic(amount: string, decimals: number): bigint {
  const [i, f = ""] = amount.split(".");
  if (!/^\d+$/.test(i) || !/^\d*$/.test(f) || f.length > decimals) throw new Error(`bad amount ${amount}`);
  return BigInt(i + f.padEnd(decimals, "0"));
}
function fromAtomic(v: string, decimals: number): string {
  const s = v.padStart(decimals + 1, "0");
  return `${s.slice(0, -decimals)}.${s.slice(-decimals).replace(/0+$/, "").padEnd(2, "0")}`;
}

export interface X402RailConfig {
  buyerPrivateKey: string; // 0x-hex secp256k1 key; kept in a private field, never logged
  payTo: string; // seller's address
  facilitatorUrl?: string; // default X402_FACILITATOR_URL or https://x402.org/facilitator
  net?: X402Network;
  holdSeconds?: number; // validBefore = now + holdSeconds; default 24h
  fetchImpl?: typeof fetch;
}

interface Held { requirements: Record<string, unknown>; payload: { x402Version: 2; accepted: Record<string, unknown>; payload: { signature: string; authorization: Authorization } }; expiresAt: string }

export class X402Rail implements Rail {
  readonly name = "x402";
  readonly buyer: string;
  #key: Uint8Array;
  #held = new Map<string, Held>();
  private net: X402Network;
  private url: string;
  private f: typeof fetch;
  constructor(private cfg: X402RailConfig) {
    this.#key = Buffer.from(cfg.buyerPrivateKey.replace(/^0x/, ""), "hex");
    this.buyer = addressOf(this.#key);
    this.net = cfg.net ?? BASE_SEPOLIA;
    this.url = (cfg.facilitatorUrl ?? process.env.X402_FACILITATOR_URL ?? "https://x402.org/facilitator").replace(/\/$/, "");
    this.f = cfg.fetchImpl ?? fetch;
  }

  async hold(job: Job) {
    if (job.currency !== "USDC") throw new Error(`x402 rail pays USDC, job is in ${job.currency}`);
    const n = this.net;
    const holdSeconds = this.cfg.holdSeconds ?? 86400;
    const validBefore = Math.floor(Date.now() / 1000) + holdSeconds;
    const authorization: Authorization = {
      from: this.buyer,
      to: this.cfg.payTo,
      value: toAtomic(job.amount, n.decimals).toString(),
      validAfter: "0",
      validBefore: String(validBefore),
      nonce: `0x${hex(randomBytes(32))}`,
    };
    const sig = secp256k1.sign(transferDigest(n, authorization), this.#key, { prehash: false, format: "recovered" }); // recid || r || s
    const signature = `0x${hex(sig.slice(1))}${(27 + sig[0]).toString(16)}`;
    const requirements = { scheme: "exact", network: n.network, amount: authorization.value, asset: n.asset, payTo: this.cfg.payTo, maxTimeoutSeconds: holdSeconds, extra: { name: n.name, version: n.version } };
    const holdRef = `${n.network}:${authorization.nonce}`;
    this.#held.set(holdRef, { requirements, payload: { x402Version: 2, accepted: requirements, payload: { signature, authorization } }, expiresAt: new Date(validBefore * 1000).toISOString() });
    return { holdRef };
  }

  /** The signed payload is the hold; read back what it authorizes. */
  async confirm(holdRef: string) {
    const h = this.get(holdRef);
    return { ref: holdRef, amount: fromAtomic(h.payload.payload.authorization.value, this.net.decimals), currency: "USDC", expiresAt: h.expiresAt };
  }

  async capture(ref: string, _note: string) {
    const h = this.get(ref);
    const body = { x402Version: 2, paymentPayload: h.payload, paymentRequirements: h.requirements };
    const v = await this.post("/verify", body);
    if (!v.isValid) throw new Error(`x402 verify failed: ${v.invalidReason ?? "invalid"}`);
    const s = await this.post("/settle", body);
    if (!s.success) throw new Error(`x402 settle failed: ${s.errorReason ?? "unknown"}`);
    this.#held.delete(ref);
    return { captureId: s.transaction as string, status: "SETTLED" };
  }

  async void(ref: string) {
    const h = this.get(ref);
    this.#held.delete(ref);
    return { status: `DISCARDED (expires ${h.expiresAt})` };
  }

  private get(ref: string): Held {
    const h = this.#held.get(ref);
    if (!h) throw new Error(`no x402 hold ${ref}`);
    return h;
  }

  private async post(path: string, body: unknown): Promise<any> {
    const res = await this.f(`${this.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`x402 facilitator ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

/** Stand-in facilitator with the documented /verify and /settle shapes, for tests and offline demos.
 * Checks the signature, recipient, amount, expiry and nonce reuse; settle returns a fake tx hash. */
export function mockFacilitator(net: X402Network = BASE_SEPOLIA) {
  const calls: string[] = [];
  const used = new Set<string>();
  const impl: typeof fetch = async (input, init) => {
    const p = new URL(input instanceof Request ? input.url : String(input)).pathname;
    calls.push(`${init?.method ?? "GET"} ${p}`);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    const { paymentPayload, paymentRequirements: r } = JSON.parse(String(init?.body));
    const { signature, authorization: a } = paymentPayload.payload as { signature: string; authorization: Authorization };
    const sig = Buffer.from(signature.slice(2), "hex");
    const recovered = secp256k1.Signature.fromBytes(Buffer.concat([Uint8Array.of(sig[64] - 27), sig.subarray(0, 64)]), "recovered");
    const signer = ethAddressFromUncompressedPublicKey(recovered.recoverPublicKey(transferDigest(net, a)).toBytes(false));
    const invalid =
      signer !== a.from.toLowerCase() ? "invalid_exact_evm_payload_signature"
      : a.to.toLowerCase() !== String(r.payTo).toLowerCase() ? "invalid_exact_evm_payload_recipient_mismatch"
      : BigInt(a.value) < BigInt(r.amount) ? "invalid_exact_evm_payload_authorization_value"
      : Number(a.validBefore) < Date.now() / 1000 ? "invalid_exact_evm_payload_authorization_valid_before"
      : used.has(a.nonce) ? "invalid_exact_evm_payload_authorization_nonce_used"
      : undefined;
    if (p.endsWith("/verify")) return json(invalid ? { isValid: false, invalidReason: invalid, payer: a.from } : { isValid: true, payer: a.from });
    if (p.endsWith("/settle")) {
      if (invalid) return json({ success: false, errorReason: invalid, transaction: "", network: r.network, payer: a.from });
      used.add(a.nonce);
      return json({ success: true, transaction: `0x${sha256Hex(a.nonce)}`, network: r.network, payer: a.from });
    }
    return json({ error: "not found" }, 404);
  };
  return { impl, calls };
}
