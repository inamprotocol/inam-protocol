import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ethAddressFromUncompressedPublicKey } from "./crypto/secp256k1.js";
import type { CheckItem, PaymentOption } from "./check.js";

/** Payee binding: a wallet signs (EIP-712) the MCP registry server name it is paid for.
 * Shape agreed in agentic-commerce-protocol discussion #317; it lives in the registry entry at
 * `_meta["io.modelcontextprotocol.registry/publisher-provided"].payeeBinding`.
 * A valid signature proves the wallet signed the binding. It does not prove control of the server. */
export interface PayeeBinding {
  domain: { name: string; version: string; chainId: number };
  primaryType: "PayeeBinding";
  message: { serverName: string; wallet: string; walletChainId: number; repository: string; issuedAt: number; sequence: number };
  signature: string;
}

export const PAYEE_BINDING_DOMAIN = { name: "INAM Payee Binding", version: "1" };
export const MCP_REGISTRY = "https://registry.modelcontextprotocol.io";
const PUBLISHER_META = "io.modelcontextprotocol.registry/publisher-provided";

const utf8 = (s: string) => new TextEncoder().encode(s);
const uint = (n: number | bigint) => Buffer.from(BigInt(n).toString(16).padStart(64, "0"), "hex");
const cat = (...parts: Uint8Array[]) => Buffer.concat(parts);

export function payeeBindingDigest(b: PayeeBinding): Uint8Array {
  const m = b.message;
  const domain = keccak_256(cat(keccak_256(utf8("EIP712Domain(string name,string version,uint256 chainId)")), keccak_256(utf8(b.domain.name)), keccak_256(utf8(b.domain.version)), uint(b.domain.chainId)));
  const struct = keccak_256(
    cat(
      keccak_256(utf8("PayeeBinding(string serverName,address wallet,uint256 walletChainId,string repository,uint64 issuedAt,uint64 sequence)")),
      keccak_256(utf8(m.serverName)),
      uint(BigInt(m.wallet)),
      uint(m.walletChainId),
      keccak_256(utf8(m.repository)),
      uint(m.issuedAt),
      uint(m.sequence),
    ),
  );
  return keccak_256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** Offline check of one binding: shape, domain, and that the signature recovers to `message.wallet` (EOA only). */
export function verifyPayeeBinding(b: PayeeBinding): { ok: true } | { ok: false; reason: string } {
  try {
    const m = b?.message;
    if (b?.primaryType !== "PayeeBinding" || !m || !/^0x[0-9a-fA-F]{40}$/.test(m.wallet) || typeof m.serverName !== "string" || typeof m.repository !== "string") return { ok: false, reason: "not a PayeeBinding object" };
    for (const n of [b.domain?.chainId, m.walletChainId, m.issuedAt, m.sequence]) if (!Number.isSafeInteger(n) || n < 0) return { ok: false, reason: "chainId, issuedAt and sequence must be non-negative integers" };
    if (b.domain.name !== PAYEE_BINDING_DOMAIN.name || b.domain.version !== PAYEE_BINDING_DOMAIN.version) return { ok: false, reason: `domain is not "${PAYEE_BINDING_DOMAIN.name}" version ${PAYEE_BINDING_DOMAIN.version}` };
    if (m.walletChainId !== b.domain.chainId) return { ok: false, reason: "walletChainId differs from the domain chainId" };
    const sig = Buffer.from(String(b.signature).replace(/^0x/, ""), "hex");
    if (sig.length !== 65) return { ok: false, reason: "signature is not 65 bytes" };
    const recovered = Uint8Array.of(sig[64] >= 27 ? sig[64] - 27 : sig[64], ...sig.subarray(0, 64));
    const pub = secp256k1.Point.fromBytes(secp256k1.recoverPublicKey(recovered, payeeBindingDigest(b), { prehash: false })).toBytes(false);
    const signer = ethAddressFromUncompressedPublicKey(pub);
    // ponytail: EOA only. A contract wallet (ERC-1271) lands here as "does not recover"; add an isValidSignature eth_call when a seller publishes one.
    return signer === m.wallet.toLowerCase() ? { ok: true } : { ok: false, reason: `signature recovers to ${signer}, not the declared wallet (contract wallets, ERC-1271, are not checked)` };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Reads the latest registry entry for `serverName` and compares its binding with the payTo(s) about to be paid.
 * pass needs all of: the latest registry version, a signature by the wallet, the same server name, and that wallet+chain among `accepts`. */
export async function payeeBindingItem(serverName: string, accepts: PaymentOption[], opts: { mcpRegistryUrl?: string; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<CheckItem> {
  const id = "payee.binding";
  let entry: any;
  try {
    const res = await (opts.fetch ?? fetch)(`${opts.mcpRegistryUrl ?? MCP_REGISTRY}/v0/servers?search=${encodeURIComponent(serverName)}&version=latest`, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    entry = ((await res.json()) as any).servers?.find((s: any) => s.server?.name === serverName);
  } catch (e) {
    return { id, status: "warn", label: `Payee binding: could not read the MCP registry entry ${serverName}`, detail: `${(e as Error).message}. Which version is current is unknown, so nothing is concluded.` };
  }
  if (!entry) return { id, status: "warn", label: `Payee binding: the MCP registry has no server named ${serverName}` };
  const version = entry.server.version;
  const b = entry.server._meta?.[PUBLISHER_META]?.payeeBinding as PayeeBinding | undefined;
  if (!b) return { id, status: "info", label: `Payee binding: ${serverName} ${version} declares none` };
  const v = verifyPayeeBinding(b);
  if (!v.ok) return { id, status: "warn", label: `Payee binding in ${serverName} ${version} is not verified: ${v.reason}` };
  if (b.message.serverName !== serverName) return { id, status: "fail", label: `Payee binding in ${serverName} ${version} is signed for another server (${b.message.serverName})` };
  const wallet = b.message.wallet.toLowerCase();
  const paid = accepts.some((a) => a.payTo.toLowerCase() === wallet && a.chainId === b.message.walletChainId);
  const where = `read from ${serverName} ${version}, sequence ${b.message.sequence}`;
  return paid
    ? { id, status: "pass", label: `Payee binding: payTo ${wallet} on eip155:${b.message.walletChainId} signed for ${serverName}`, detail: `EIP-712, ${where}. The wallet signed the binding; this does not prove control of the server or deployment.` }
    : { id, status: "fail", label: `Payee binding: ${serverName} is bound to ${wallet} on eip155:${b.message.walletChainId}, which is not a payTo offered here`, detail: `${where}. The endpoint asks you to pay a wallet the registry entry did not sign for.` };
}
