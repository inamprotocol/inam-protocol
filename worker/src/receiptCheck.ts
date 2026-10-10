// Hosted receipt check (POST /v1/receipts/:id/verify). Re-runs, on the
// registry's side, the checks anyone can do from public data: both
// signatures, the content-addressed id, the transparency-log leaf, the
// parties' revocation state, dispute state, and (if the caller supplies the
// text) the spec/output hashes.
//
// Deliberately NOT a Verification record (§12) and NOT a log entry: the
// registry did not re-execute the work, so this must never count as
// independent evidence or move reputation; and an unauthenticated read that
// appended a leaf would let anyone grow the log. The answer is instead
// signed with the registry's hosted-agent key (DEMO_PRIVATE_KEY, the §14
// demo counterparty's identity) so a caller can hand it to a third party.
// ponytail: reuses the demo key; a dedicated attestation key needs its own secret.
import { canonicalize } from "../../sdk-js/src/crypto/canonical.js";
import { fromHex, keypairFromPrivateKey, sha256Hex, sign, toBase64, verify } from "../../sdk-js/src/crypto/keys.js";
import { computeReceiptId } from "../../sdk-js/src/core/receiptContent.js";
import { isDisputeActive } from "../../sdk-js/src/core/disputeLifecycle.js";
import { leafHash, rootHash, inclusionProof, verifyInclusion } from "../../sdk-js/src/core/merkleLog.js";
import { payloadHash } from "../../sdk-js/src/core/transparencyLog.js";
import * as db from "./db.js";
import { attestationVerdict } from "./verificationService.js";
import type { Env, ExecutionReceipt } from "./types.js";

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export type CheckResult = "pass" | "fail" | "skipped";
export interface Check {
  name: string;
  result: CheckResult;
  detail: string;
}

const SCOPE =
  "Integrity checks run by the registry on stored data. The work was not re-executed; this is not an independent verification (SPEC.md §12) and does not change reputation.";

function sigOk(sig: string | undefined, bytes: Uint8Array, did: string): boolean {
  if (!sig) return false;
  try {
    return verify(Buffer.from(sig, "base64"), bytes, did);
  } catch {
    return false;
  }
}

function stripUnsigned(r: ExecutionReceipt) {
  return { ...r, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined };
}

export async function checkReceipt(env: Env, r: ExecutionReceipt, given: { spec?: string; output?: string }) {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean | null, pass: string, fail: string) =>
    checks.push({ name, result: ok === null ? "skipped" : ok ? "pass" : "fail", detail: ok === false ? fail : pass });

  add("finalized", r.status !== "draft", `status is ${r.status}`, "status is draft: not countersigned");

  const signed = new TextEncoder().encode(canonicalize(stripUnsigned(r)));
  add("agent_b_signature", sigOk(r.signatures.agentB, signed, r.agentB.id), "worker signature valid", "worker signature missing or invalid");
  add("agent_a_signature", sigOk(r.signatures.agentA, signed, r.agentA.id), "requester signature valid", "requester signature missing or invalid");

  const expectedId = computeReceiptId(r.agentA.id, r.agentB.id, r);
  add("receipt_id", expectedId === r.receiptId, "receiptId is the hash of the receipt content", `receiptId does not match content (expected ${expectedId})`);

  let log: { leafIndex: number; treeSize: number; rootHash: string; leafHash: string; proof: string[] } | null = null;
  const entry = await db.transparencyEntryByRef(env, "receipt_finalized", r.receiptId);
  if (!entry) {
    add("transparency_log", false, "", "no receipt_finalized leaf for this receipt (drafts and receipts finalized before v0.30 have none)");
  } else {
    const leaves = await db.transparencyLeafHashes(env);
    const root = rootHash(leaves);
    const proof = inclusionProof(leaves, entry.leafIndex);
    log = { leafIndex: entry.leafIndex, treeSize: leaves.length, rootHash: root, leafHash: entry.leafHash, proof };
    const stored = JSON.parse(entry.data) as { dataHash?: string };
    let problem: string | null = null;
    if (leafHash(new TextEncoder().encode(entry.data)) !== entry.leafHash) problem = "leaf hash does not match entry bytes";
    else if (!verifyInclusion(entry.leafHash, entry.leafIndex, leaves.length, proof, root)) problem = "inclusion proof does not verify";
    else if (entry.payload !== null) {
      const logged = JSON.parse(entry.payload) as ExecutionReceipt;
      if (payloadHash(entry.payload) !== stored.dataHash) problem = "payload does not match the leaf's dataHash";
      else if (canonicalize({ ...stripUnsigned(logged), sig: logged.signatures }) !== canonicalize({ ...stripUnsigned(r), sig: r.signatures }))
        problem = "logged receipt differs from the stored receipt";
    }
    const how = entry.payload === null ? " (payload withheld: leaf only, content not compared)" : " and matches the stored receipt";
    add("transparency_log", problem === null, `included at leaf ${entry.leafIndex} of ${leaves.length}${how}`, problem ?? "");
  }

  // Creation has required this format since spec v0.32 (draftReceiptSchema); records
  // older than that (e.g. live log leaf 0) carry placeholders like "sha256:spec".
  const badHashes = [["task.specHash", r.task?.specHash], ["result.outputHash", r.result?.outputHash]].filter(([, h]) => !HASH_RE.test(String(h)));
  add("hash_format", badHashes.length === 0, "specHash and outputHash are sha256: + 64 lowercase hex",
    `pre-v0.32 test record: placeholder hashes, not content hashes (${badHashes.map(([k, h]) => `${k} ${JSON.stringify(h)}`).join(", ")})`);

  const hashCheck = (name: string, text: string | undefined, expected: string, what: string) =>
    add(name, text === undefined ? null : `sha256:${sha256Hex(text)}` === expected, text === undefined ? `no ${what} text supplied` : `${what} text hashes to ${expected}`, `${what} text does not hash to ${expected}`);
  hashCheck("spec_hash", given.spec, r.task.specHash, "spec");
  hashCheck("output_hash", given.output, r.result.outputHash, "output");

  const [a, b] = await Promise.all([db.getAgent(env, r.agentA.id), db.getAgent(env, r.agentB.id)]);
  const revoked = [a, b].filter((x) => x?.revokedAt).map((x) => `${x!.id} revoked at ${x!.revokedAt}`);
  add("parties_not_revoked", revoked.length === 0, "neither party is revoked", revoked.join("; "));

  const active = isDisputeActive(r);
  add("no_active_dispute", !active, r.dispute.status === "resolved" ? "dispute was opened and resolved" : "no dispute", `dispute open: ${r.dispute.reason ?? "no reason given"}`);

  const failed = checks.filter((c) => c.result === "fail");
  const { verdict: independentVerification } = await attestationVerdict(env, r.receiptId);
  const body = {
    type: "inam.receipt_check.v1",
    receiptId: r.receiptId,
    checkedAt: new Date().toISOString(),
    verdict: failed.length === 0 ? "pass" : "fail",
    checks,
    log,
    independentVerification,
    scope: SCOPE,
    nextStep: failed.length
      ? `Do not rely on this receipt as recorded: ${failed.map((c) => c.name).join(", ")} failed.`
      : given.spec === undefined || given.output === undefined
        ? "Integrity checks passed. Supply the spec and output text to also bind them to this receipt."
        : independentVerification === "verified"
          ? "Integrity checks passed and an authorized verifier has verified this receipt."
          : "Integrity checks passed. Whether the output is correct was not checked by an independent verifier.",
  };

  if (!env.DEMO_PRIVATE_KEY) return { ...body, attestation: null };
  const kp = keypairFromPrivateKey(fromHex(env.DEMO_PRIVATE_KEY));
  return { ...body, attestation: { signer: kp.did, alg: "Ed25519", signature: toBase64(sign(new TextEncoder().encode(canonicalize(body)), kp.privateKey)) } };
}
