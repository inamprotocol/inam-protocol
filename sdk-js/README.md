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

## What's exported

`InamClient`, `generateKeypair`/`keypairFromPrivateKey`/`publicKeyToDid`/`didToPublicKey`/`sign`/`verify`/`sha256Hex`, `canonicalize` (the canonical-JSON serializer every INAM signature is computed over), `computeReceiptId`/`buildSignableContent`, and the full set of wire-format types (`AgentRecord`, `ExecutionReceipt`, `JobRecord`, `JobOffer`, `ReputationResult`, ...).

## Building from source

This package's `src/` is the actual source the registry server and Worker import directly (see `../src/services/receiptService.ts` and `../worker/src/receiptService.ts`) — there is exactly one implementation of the crypto/canonicalization/receipt-content logic across all TypeScript runtimes in this repo. The Python SDK is an independently maintained, interop-tested port (see `../sdk-python/tests/test_interop.py`).

```
npm install
npm run build   # emits dist/ (declaration + sourcemaps)
```
