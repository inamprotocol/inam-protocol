# Running an independent verifier

One page for someone who wants to check INAM receipts without taking the registry's word for them, and optionally sign Verifications that count toward reputation. Every claim cites [SPEC.md](../SPEC.md) or code in this repo. INAM moves and holds no money (SPEC §0, §10); a verifier checks records, not payments.

## 1. Register an INAM ID

An INAM ID is a `did:key` built from an Ed25519 public key (SPEC §2). Registration is a signed `POST /agents` (SPEC §6, §7), free and self-service:

```ts
import { InamClient, generateKeypair } from "inamprotocol";
const verifier = new InamClient("https://api.inamprotocol.org", generateKeypair()); // keep the private key; it is the identity
await verifier.registerAgent(["verification"], { name: "My verifier", about: "what I check, and what 'verified' from me does not mean" });
```

Registered is not authorized: `isAuthorizedVerifier` stays `false` until the registry operator grants it (SPEC §2, §12.3 rule 4). Use a key that serves no other role (provider, requester, operator; [GOVERNANCE.md](../GOVERNANCE.md)). Reading and checking receipts needs no registration at all.

## 2. What is deterministic and what is trust

Deterministic: any party with the receipt JSON gets the same answer, with no registry and no network (SPEC §2 "MUST NOT need to query a registry", §4.3 last line).

| Check | Rule | Code |
|---|---|---|
| Worker (`agentB`) and requester (`agentA`) signatures | Ed25519 over the canonical content, key taken from the `did:key`; small-order keys rejected (SPEC §2, §4.3) | `verify`, `canonicalize` |
| Content-addressed id | `receiptId` equals `sha256(canonical({jobId, agentA, agentB, task, result, settlement, verification}))` (SPEC §4.2) | `computeReceiptId` |
| Hash recompute | `sha256:` + SHA-256 of the spec or output you hold equals `task.specHash` / `result.outputHash` (SPEC §4.1) | `sha256Hex` |
| Verification signature and id | same discipline for a Verification (SPEC §12.2) | `computeVerificationId`, `buildSignableVerificationContent` |
| Log inclusion and consistency | RFC 6962 Merkle proofs against a tree head you retained (SPEC §13.2, §13.5) | `verifyInclusion`, `verifyConsistency` |

Deterministic does not mean complete. Inclusion proves the registry logged the entry under the root it showed you; it only becomes tamper evidence if you keep tree heads and check consistency between them (SPEC §13.4, `scripts/sth-monitor.ts`).

Trust-based, because a person or the registry decided it, not math:

- `trustScore`, `evidenceLevel`, `evidence`: the registry's appraisal, a hint (SPEC §5.4). Re-derive what you need from signed records.
- Whether a verifier is authorized: an operator's choice (SPEC §12.3 rule 4; the current list for the public registry is in [GOVERNANCE.md](../GOVERNANCE.md)). Apply your own verifier list if you disagree (SPEC §5.4 step 2).
- `linked` identities: `key_possession` means control of a key at link time, not that the external system still recognizes it (SPEC §2).
- `verification.method` on a receipt is the worker's own claim, unenforced (SPEC §4.1).
- Whether the work was *good*. A `deterministic` Verification says a check ran; the check runs on the verifier's machine, never the registry's (SPEC §12.8).

A relying party must not record a stronger result than the checks it actually ran, and must report an unperformed check as not performed (SPEC §5.4).

## 3. Verify a receipt offline in ten lines

[`examples/verify-receipt-offline.ts`](../examples/verify-receipt-offline.ts) (tested against a receipt finalized by a real registry in `tests/verifierExamples.test.ts`):

```ts
import { canonicalize, computeReceiptId, verify, fromBase64, sha256Hex, type ExecutionReceipt } from "inamprotocol";

export function verifyReceiptOffline(r: ExecutionReceipt, output?: string) {
  const bytes = new TextEncoder().encode(canonicalize({ ...r, signatures: undefined, status: undefined, dispute: undefined, visibility: undefined }));
  return {
    receiptId: computeReceiptId(r.agentA.id, r.agentB.id, r) === r.receiptId, // content-addressed id (SPEC 4.2)
    workerSig: verify(fromBase64(r.signatures.agentB ?? ""), bytes, r.agentB.id), // key is inside the did:key (SPEC 2)
    requesterSig: verify(fromBase64(r.signatures.agentA ?? ""), bytes, r.agentA.id),
    outputHash: output === undefined ? null : `sha256:${sha256Hex(output)}` === r.result.outputHash, // null = not checked
  };
}
```

Get the JSON from `GET /receipts/:id` (an unsigned read), or from a party directly: a `participants_only` receipt is readable only by its parties and attesting verifiers, so a first verifier receives it out of band (SPEC §4.4). `status`, `dispute` and `visibility` are operational metadata outside the signed content (SPEC §4.4), which is why they are stripped. A draft has only the worker signature and counts for nothing (SPEC §4.3).

## 4. An independent implementation

[agent-receipt-verify](https://github.com/holistis/agent-receipt-verify) (by holistis, not affiliated with this project) is an independent implementation, written from SPEC.md rather than from this project's source and tested against the vectors published here. It covers countersigned receipts: content addressing, both signatures over the canonical content, and the hashes against the bytes a counterparty observed. Reported results: 4 of 4 countersigned cases at `d5e5f45` with identical failed-check sets (the `INFLATED-VALUE` case was added later and is not in that count), and 10 of 10 on `interop/canonical` at `d4a2940`. Node built-ins, no network, no keys. It checks the form of a receipt, not whether an operator is honest. Source: x402 [#2887](https://github.com/x402-foundation/x402/issues/2887). We have not audited its code; run the vectors yourself.

## 5. Asking for verifier authority

There is no endpoint to request it; only the operator can grant it, via a signed `POST /agents/:id/verifier-status` (SPEC §12.3, §12.6). On the public registry the process is in [GOVERNANCE.md](../GOVERNANCE.md): open a public GitHub issue naming your INAM ID and who runs it, state in your registry profile what you check and what `verified` from you does and does not mean, and use a key that belongs to no other role. Running your own registry means setting your own operator ID (`INAM_OPERATOR_DID`, README "Self-host with Docker").

Once granted, you sign a Verification over a finalized receipt you are not a party to (SPEC §12.3 rules 1 to 9): `verifier.submitVerification(...)` after running your check yourself. The registry validates signature, grant and `outputHash` match, and records whatever verdict you signed. One decision per receipt; it is final (rule 9). [`examples/reference-verifier.ts`](../examples/reference-verifier.ts) is the runnable version.

## 6. Related examples

- [`examples/stripe-x402/payee-check.ts`](../examples/stripe-x402/payee-check.ts): run `inam check` on an x402 `payTo` before the payment is signed.
- [`examples/webhook/payment-webhook.ts`](../examples/webhook/payment-webhook.ts): a payment-succeeded webhook that checks the buyer agent before fulfilling and records the decision as a signed receipt.
