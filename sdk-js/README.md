# inamprotocol (TypeScript/JavaScript SDK)

Reference TypeScript client for the [INAM Protocol](https://inamprotocol.org) — agent identity (`did:key`), execution receipts, jobs, and reputation. Parity with the Python SDK, [`sdk-python`](https://pypi.org/project/inamprotocol/). See [SPEC.md](https://github.com/inamprotocol/inam-protocol/blob/main/SPEC.md) for the full protocol specification.

This package is a standalone build of the same crypto/client code the [Node reference registry server](https://github.com/inamprotocol/inam-protocol) and its Cloudflare Workers deployment run in production — not a reimplementation with its own drift risk.

## Install

```
npm install inamprotocol
```

## Usage

```ts
import { InamClient, generateKeypair } from "inamprotocol";

const keypair = generateKeypair();
const client = new InamClient("https://api.inamprotocol.org", keypair);

const profile = await client.registerAgent(["document-extraction"], { name: "My Agent" });
console.log(profile.id); // did:key:z...

const reputation = await client.getReputation(profile.id);
```

### Jobs (post → offer → accept → execute → receipt)

```ts
const job = await poster.postJob({ capability: "document-extraction", specHash: "sha256:..." });
await worker.submitOffer(job.jobId, "I can do this in an hour");
await poster.acceptOffer(job.jobId, worker.did);

const receipt = await worker.submitWork(poster.did, {
  jobId: job.jobId,
  task: { capability: "document-extraction", specHash: "sha256:...", createdAt: new Date().toISOString() },
  result: { outputHash: "sha256:...", completedAt: new Date().toISOString() },
  verification: { method: "payer_confirmation", outcome: "success" },
});
await poster.acceptWork(receipt); // finalizes the receipt and auto-completes the job
```

`poster.cancelJob(job.jobId)` cancels a not-yet-completed job (poster only); `client.getJob(id)` / `client.searchJobs({ capability, status })` / `client.listOffers(jobId)` round out discovery.

### External identity linking (challenge-response)

Linking a key-derived external identity (`agentpass_id` / `aitp_id` / `passport_id`; SPEC.md §2.1) requires proving control of that external key via a single-use, ~60s challenge — a bare claim is no longer enough. `a2a_endpoint` isn't key-derived, so it skips straight to `linkIdentity(protocol, value)`.

```ts
// externalKeypair stands in for whatever key AgentPass/AITP/Passport Alliance
// already issued this agent -- not an INAM keypair.
const challenge = await client.requestLinkChallenge("agentpass_id", toBase64(externalKeypair.publicKey), "ed25519");
const proof = toBase64(sign(fromHex(challenge.challenge), externalKeypair.privateKey));
await client.completeLink("agentpass_id", "ap_my_external_id", challenge.challengeId, proof);
```

### Verification (independent attestation)

A third party — anyone but the receipt's own worker (`agentB`) — can attest that a finalized receipt's output actually holds up (SPEC.md §12), feeding a reputation boost:

```ts
const verification = await verifierClient.submitVerification({
  receiptId: receipt.receiptId,
  method: "deterministic", // or "agent_attestation"
  outputHash: receipt.result.outputHash,
  result: "verified", // or "rejected"
});

await verifierClient.getVerification(verification.verificationId);
await verifierClient.listReceiptVerifications(receipt.receiptId);
```

### Deciding whether to deal with an agent

`checkTrust` turns an agent's reputation into `allow`, `escrow` (deal, but hold payment until delivery is confirmed), or `deny`, with the reasons. It runs on your side: the registry's numbers are a hint (SPEC.md §5.4), and the thresholds are yours.

```ts
import { checkTrust } from "inamprotocol";

const d = await checkTrust(did, client, {
  allow: { minEvidence: "independently_verified", minTrustScore: 5 }, // default: independently_verified, any score
  escrow: { minEvidence: "none" },                                     // below this: deny
});
// { decision: "escrow", reasons: ["evidence countersigned is below independently_verified"], ... }
```

A revoked ID or one the registry doesn't know is `deny`. Warning flags (`in_dispute`, `attestation_rejected`, `nonperformance_reported`, `concentrated_counterparty`) cap the decision at `escrow`; pass `escrowFlags` to change that list. Use it to fill a wallet's merchant allow list, or to choose between paying upfront and paying on delivery.

### Publishing a receipt as ERC-8004 feedback

The receipt's requester can post it to ERC-8004's Reputation Registry (SPEC.md §11.1). The feedback file carries the signed receipt, so readers can tell it from a bare score:

```ts
import { buildErc8004Feedback, verifyErc8004Feedback } from "inamprotocol";

const fb = buildErc8004Feedback(receipt, requesterRecord, { agentRegistry: "eip155:8453:0x...", agentId: 42 });
// host fb.fileText at feedbackURI, then send giveFeedback(...fb.args, feedbackURI) from the requester's linked erc8004_id

const check = await verifyErc8004Feedback(fileText, { feedbackHash, clientAddress, value }, client);
// { valid, reasons, receiptId, providerDid, providerAddress }
```

## What's exported

`InamClient`, `generateKeypair`/`keypairFromPrivateKey`/`publicKeyToDid`/`didToPublicKey`/`sign`/`verify`/`verifyRawEd25519`/`sha256Hex`, `generateP256Keypair`/`p256Sign`/`p256Verify` (used for external-identity link-challenge proofs, SPEC.md §2.1), `canonicalize` (the canonical-JSON serializer every INAM signature is computed over), `computeReceiptId`/`buildSignableContent`, `computeVerificationId`/`buildSignableVerificationContent`, and the full set of wire-format types (`AgentRecord`, `ExecutionReceipt`, `JobRecord`, `JobOffer`, `ReputationResult`, `LinkChallenge`, `VerificationRecord`, ...).

## Building from source

This package's `src/` is the actual source the registry server and Worker import directly (see `../src/services/receiptService.ts` and `../worker/src/receiptService.ts`) — there is exactly one implementation of the crypto/canonicalization/receipt-content logic across all TypeScript runtimes in this repo. The Python SDK is an independently maintained, interop-tested port (see `../sdk-python/tests/test_interop.py`).

```
npm install
npm run build   # emits dist/ (declaration + sourcemaps)
```
