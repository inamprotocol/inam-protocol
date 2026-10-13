import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildSignableContent, canonicalize, fromHex, keypairFromPrivateKey, publicKeyToDid, sha256Hex,
  sign, toBase64, toHex, verify, verifyRawEd25519, fromBase64, type Keypair, type ReceiptContentInput,
} from "../sdk-js/src/index.js";
import { sha256 } from "@noble/hashes/sha256";

/** Agent Receipts (github.com/webaesbyamin/agent-receipts, MIT) local receipt -> INAM receipt.
 *
 * An Agent Receipts receipt is signed by one key: the local install's own Ed25519 key.
 * On its own that is provenance only. It says what this agent recorded about its own
 * action. It never counts toward INAM reputation. It becomes a reputation-eligible INAM
 * receipt only once the agent it did the work FOR countersigns (SPEC.md §4.3).
 *
 *   npx tsx examples/agent-receipts-adapter.ts      # offline, no server
 *
 * Mapping (their format at commit 8bbb057df9a60069bc03fea8704838e1927deacd:
 * packages/schema/src/receipt.ts, packages/crypto/src/sign.ts, packages/mcp-server/src/hash.ts):
 *   public key (hex, `get_public_key`)  -> worker did:key, the same key, no new identity
 *   action                              -> task.capability
 *   input_hash / output_hash            -> task.specHash / result.outputHash (both already sha256:<hex>)
 *   timestamp / completed_at            -> task.createdAt / result.completedAt
 *   receipt_id                          -> jobId "agent-receipts:<receipt_id>"
 *   status "completed"                  -> verification.outcome "success"; anything else is refused
 * cost_usd is NOT mapped: it is what the agent spent (model cost), not a payment between the
 * two agents, which is what settlement means in INAM (§4.1).
 *
 * examples/agent-receipts-sample.json has their receipt shape and was signed with their exact
 * algorithm, but with a TEST key (derived below from a public string). Their repo publishes no
 * real signed sample; its demo data carries placeholder signatures. */

export type AgentReceiptsSample = { public_key: string; receipt: Record<string, unknown> & {
  receipt_id: string; action: string; input_hash: string; output_hash: string | null;
  status: string; receipt_type: string; timestamp: string; completed_at: string | null; signature: string;
} };

// Their getSignablePayload() fields, and their flat canonicalize(): JSON.stringify with sorted keys.
const SIGNED_FIELDS = ["receipt_id", "chain_id", "receipt_type", "agent_id", "org_id", "action", "input_hash", "output_hash", "status", "timestamp", "completed_at", "environment"];
const HASH = /^sha256:[0-9a-f]{64}$/;

export function verifyAgentReceipt({ public_key, receipt }: AgentReceiptsSample): boolean {
  if (!receipt.signature.startsWith("ed25519:")) return false;
  const payload = Object.fromEntries(SIGNED_FIELDS.map((k) => [k, receipt[k]]));
  const message = new TextEncoder().encode(JSON.stringify(payload, Object.keys(payload).sort()));
  return verifyRawEd25519(fromBase64(receipt.signature.slice(8)), message, fromHex(public_key));
}

/** Worker side: same Ed25519 key that signed the Agent Receipts receipt signs the INAM draft. */
export function draftFromAgentReceipt(sample: AgentReceiptsSample, workerPrivateKeyHex: string, requesterDid: string) {
  const r = sample.receipt;
  if (!verifyAgentReceipt(sample)) throw new Error("Agent Receipts signature does not verify");
  if (r.receipt_type !== "action" || r.status !== "completed" || !r.completed_at) throw new Error(`only completed action receipts convert (got ${r.receipt_type}/${r.status})`);
  if (!HASH.test(r.input_hash) || !HASH.test(r.output_hash ?? "")) throw new Error("input_hash/output_hash must be sha256:<64 hex>");
  const worker = keypairFromPrivateKey(fromHex(workerPrivateKeyHex));
  if (worker.did !== publicKeyToDid(fromHex(sample.public_key))) throw new Error("worker key is not the key that signed the Agent Receipts receipt");
  const input: ReceiptContentInput = {
    jobId: `agent-receipts:${r.receipt_id}`,
    task: { capability: r.action, specHash: r.input_hash, createdAt: r.timestamp },
    result: { outputHash: r.output_hash!, completedAt: r.completed_at },
    verification: { method: "payer_confirmation", outcome: "success" },
  };
  const content = buildSignableContent(requesterDid, worker.did, input);
  // A draft: provenance only until agentA countersigns. Never counted toward reputation (§4.3).
  return { ...content, signatures: { agentB: toBase64(sign(signingBytes(content), worker.privateKey)) }, status: "draft" as const };
}

/** Requester side: recompute both hashes from the bytes it sent and got back, then countersign. */
export function countersign(draft: ReturnType<typeof draftFromAgentReceipt>, requester: Keypair, own: { input: unknown; output: unknown }) {
  // Agent Receipts hashes JSON values with deep key sorting (hash.ts hashData), which is INAM's canonicalize().
  const h = (v: unknown) => `sha256:${sha256Hex(canonicalize(v))}`;
  if (draft.agentA.id !== requester.did) throw new Error("not the named requester");
  if (draft.task.specHash !== h(own.input) || draft.result.outputHash !== h(own.output)) throw new Error("hashes do not match what the requester sent/received; not countersigning");
  if (!verify(fromBase64(draft.signatures.agentB), signingBytes(draft), draft.agentB.id)) throw new Error("worker signature invalid");
  return { ...draft, signatures: { ...draft.signatures, agentA: toBase64(sign(signingBytes(draft), requester.privateKey)) }, status: "finalized" as const };
}

function signingBytes(r: object) {
  // Same content both parties sign (SDK submitWork/acceptWork): everything but signatures/status/dispute/visibility.
  return new TextEncoder().encode(canonicalize({ ...r, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined }));
}

// TEST KEYS ONLY, derived from public strings. A real worker reads RECEIPT_SIGNING_PRIVATE_KEY,
// the same variable Agent Receipts' KeyManager reads.
export const testKey = (label: string) => sha256(new TextEncoder().encode(`INAM interop TEST KEY, never use for real: ${label}`));
// What the requester itself sent and received in the sample job.
export const SAMPLE_JOB = { input: { text: "INAM receipts are signed by both parties.", instruction: "summarize in five words" }, output: { summary: "Both sides sign each receipt." } };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const sample: AgentReceiptsSample = JSON.parse(readFileSync(new URL("agent-receipts-sample.json", import.meta.url), "utf8"));
  const requester = keypairFromPrivateKey(testKey("agent-receipts requester"));
  const workerKey = process.env.RECEIPT_SIGNING_PRIVATE_KEY ?? toHex(testKey("agent-receipts worker"));
  console.log("Agent Receipts signature:", verifyAgentReceipt(sample) ? "valid" : "INVALID");
  const draft = draftFromAgentReceipt(sample, workerKey, requester.did);
  console.log(`INAM draft ${draft.receiptId} by ${draft.agentB.id}: provenance only, not reputation`);
  const final = countersign(draft, requester, SAMPLE_JOB);
  console.log(`countersigned by ${final.agentA.id}: ${final.status}, reputation-eligible once submitted to a registry`);
  console.log(JSON.stringify(final, null, 2));
}

