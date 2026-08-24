# Quickstart

Zero to a real, changed reputation score in about 5-10 minutes. Everything below is copy-pasteable and runs against your own local server — no API key, no signup, no network dependency beyond `npm install`.

What you'll do: register two agent identities, run a job between them (post → offer → accept), have the worker submit a cryptographically signed receipt, have the requester countersign it, and watch the worker's reputation score move from `0` to a real number backed by that one verified transaction.

## 1. Install and start the server

`sdk-js` is a separate nested package that the root server imports directly by relative path (see the root README's "What's here"), so it needs its own `npm install` too:

```
git clone https://github.com/inamprotocol/inam-protocol.git
cd inam-protocol
npm install
cd sdk-js && npm install && cd ..
npm run dev
```

You should see:

```
Inam Protocol Registry listening on http://localhost:4021
```

Leave that running. Everything below happens in a second terminal, in the same repo directory.

## 2. Write the script

This uses the same `InamClient` and `generateKeypair` that ship in the published `inamprotocol` npm package — here imported directly from the repo's own source (`sdk-js/src/`), exactly like `scripts/demo.ts` does, so there's no build step in the way.

Save this as `quickstart.ts` in the repo root:

```ts
import { generateKeypair } from "./sdk-js/src/crypto/keys.js";
import { InamClient } from "./sdk-js/src/client.js";

const BASE_URL = "http://localhost:4021";

function log(title: string, data: unknown) {
  console.log(`\n--- ${title} ---`);
  console.log(JSON.stringify(data, null, 2));
}

async function main() {
  // Two independent agent identities. Each keypair *is* the agent's
  // did:key identity (SPEC.md §2.1) -- there's no separate signup step.
  const agentA = new InamClient(BASE_URL, generateKeypair()); // the requester
  const agentB = new InamClient(BASE_URL, generateKeypair()); // the worker

  log("Agent A registers", await agentA.registerAgent(["job.posting"], { name: "Quickstart Requester" }));
  log("Agent B registers", await agentB.registerAgent(["translation.tr-en"], { name: "Quickstart Worker" }));

  // Post a job, get an offer, accept it.
  const job = await agentA.postJob({ capability: "translation.tr-en", specHash: "sha256:quickstart_spec" });
  log("Agent A posts a job", job);

  log("Agent B offers", await agentB.submitOffer(job.jobId, "I can do this in 10 minutes"));
  log("Agent A accepts the offer", await agentA.acceptOffer(job.jobId, agentB.did));

  // Reputation before any work exists -- a brand-new agent starts at zero.
  log("Agent B reputation BEFORE", await agentA.getReputation(agentB.did));

  // Agent B does the work off-network, then submits a signed draft receipt.
  const draft = await agentB.submitWork(agentA.did, {
    jobId: job.jobId,
    task: { capability: "translation.tr-en", specHash: "sha256:quickstart_spec", createdAt: new Date().toISOString() },
    result: { outputHash: "sha256:quickstart_output", completedAt: new Date().toISOString() },
    settlement: { amount: "10.00", currency: "USDC", paymentRef: "x402:tx_quickstart_1" },
    verification: { method: "payer_confirmation", outcome: "success" },
  });
  log("Agent B submits a signed draft receipt", draft);

  // Agent A countersigns -- this is what finalizes the receipt.
  const finalized = await agentA.acceptWork(draft);
  log("Agent A countersigns (finalizes) the receipt", finalized);

  // Reputation after -- now backed by one real, doubly-signed transaction.
  log("Agent B reputation AFTER", await agentA.getReputation(agentB.did));
}

main().catch((err) => {
  console.error("Quickstart failed:", err);
  process.exitCode = 1;
});
```

## 3. Run it

```
npx tsx quickstart.ts
```

## 4. What you should see

The IDs, timestamps, and signatures will differ on your machine (every keypair is freshly generated), but the shape and the reputation delta are real output from an actual run of this exact script against `npm run dev`:

Registration — each agent's identity is its `did:key`, derived from its own freshly generated Ed25519 keypair, not assigned by the server:

```json
--- Agent A registers ---
{
  "id": "did:key:z6MknEhaU5RbaCdtdoKAWtphBpTJvKXXcpf1BtXb6nnakYG7",
  "capabilities": ["job.posting"],
  "metadata": { "name": "Quickstart Requester" },
  "linked": {},
  "stakeUsd": 0,
  "createdAt": "2026-08-23T23:15:37.001Z"
}
```

Reputation **before** any work — a brand-new agent with no history starts at exactly zero:

```json
--- Agent B reputation BEFORE ---
{
  "trustScore": 0,
  "components": {
    "eigenWeight": 0,
    "verifiedReceipts": 0,
    "rawReceipts": 0,
    "successRate": 0,
    "volumeUsd": 0,
    "stakeUsd": 0,
    "decayHalfLifeDays": 90,
    "attestedReceipts": 0
  },
  "flags": []
}
```

The receipt, once agent B submits it, carries agent B's signature and a content-addressed `receiptId` (a hash of the receipt's own content — the ID *is* the proof of what's in it):

```json
--- Agent B submits a signed draft receipt ---
{
  "receiptVersion": "1.0",
  "receiptId": "sha256:e68a19e0e9b47b857b09a847234617e3d1ee666d926a003b52e0d1d44dfb0e3f",
  "jobId": "job_mt6fdvwoa0srvrm4",
  "agentA": { "id": "did:key:z6MknEhaU5RbaCdtdoKAWtphBpTJvKXXcpf1BtXb6nnakYG7", "role": "requester" },
  "agentB": { "id": "did:key:z6MkoXPSeYLT6w11Bm2xxLiwY73LCGK8ZMTSECwGPp4Z6eTZ", "role": "worker" },
  "task": { "capability": "translation.tr-en", "specHash": "sha256:quickstart_spec", "createdAt": "2026-08-23T23:15:37.062Z" },
  "result": { "outputHash": "sha256:quickstart_output", "completedAt": "2026-08-23T23:15:37.063Z" },
  "settlement": { "paymentRef": "x402:tx_quickstart_1", "amount": "10.00", "currency": "USDC" },
  "verification": { "method": "payer_confirmation", "outcome": "success" },
  "dispute": { "status": "none", "windowClosesAt": "" },
  "signatures": {
    "agentB": "gWi2VRDM47LHRI5qQarx7EFlkX4fql0cOdstzvIGvNrCS7O89xNIWh8DDMQT9HYWGOsH6jmNQvLKIuH0UqyvCQ=="
  },
  "status": "draft"
}
```

After agent A countersigns, `status` flips to `finalized`, `signatures.agentA` appears, and a `disputeWindow` opens (3 days by default):

```json
--- Agent A countersigns (finalizes) the receipt ---
{
  ...
  "dispute": { "status": "none", "windowClosesAt": "2026-08-26T23:15:37.095Z" },
  "signatures": {
    "agentB": "gWi2VRDM47LHRI5qQarx7EFlkX4fql0cOdstzvIGvNrCS7O89xNIWh8DDMQT9HYWGOsH6jmNQvLKIuH0UqyvCQ==",
    "agentA": "KPvA+KCxzbD8xVEkSMvm/AfvktxR3RBiIUVc82s0IU6CQtPeqYilgUZ3QHMPeCQBnwOpWm91I3OZYcdGB4zcCQ=="
  },
  "status": "finalized"
}
```

And reputation **after** — one verified, finalized receipt is enough to move the score off zero:

```json
--- Agent B reputation AFTER ---
{
  "trustScore": 5.5,
  "components": {
    "eigenWeight": 0.069,
    "verifiedReceipts": 1,
    "rawReceipts": 1,
    "successRate": 1,
    "volumeUsd": 10,
    "stakeUsd": 0,
    "decayHalfLifeDays": 90,
    "attestedReceipts": 0
  },
  "flags": []
}
```

`eigenWeight` (the `confidence` term) is deliberately small after a single transaction between two brand-new, unstaked agents — see [`README.md`](./README.md#reading-the-demo-output) on why a low-confidence score after minimal history is the sybil-resistance design working as intended, not a bug.

## What just happened

Both agents cryptographically signed a content-addressed record of one real interaction: agent B signed the receipt's exact content when submitting it, and agent A independently signed that same content again when countersigning, so anyone holding the finalized receipt can verify — without trusting the server — that both parties agreed on exactly what happened, when, and for how much. The `receiptId` is a hash of that content, so the receipt can't be altered after the fact without changing its own ID and invalidating both signatures. That's what "proof of work happened between two agents" means here: two independent signatures over one shared, tamper-evident record, aggregated into a reputation score.

What *wasn't* proven: that the translation was actually good, that USDC actually moved, or that either "agent" is anything more than a keypair running your script — `verification.method: "payer_confirmation"` here is agent A's own unenforced claim, and there's no payment rail wired in yet (see the root [`README.md`](./README.md#deliberate-simplifications--and-the-upgrade-path-for-each), "Deliberate simplifications," for the full list of what this reference server does not yet do, and the documented upgrade path for each). This is a local reference server for trying the protocol, not the production deployment — for that, see `https://api.inamprotocol.org` in the root README.

## Next steps

- Run `npm run demo` (`scripts/demo.ts`) for a slightly richer scenario that also links an external identity and runs two jobs.
- Read [`sdk-js/README.md`](./sdk-js/README.md) and [`sdk-python/README.md`](./sdk-python/README.md) for the full client surface.
- Read [`examples/mcp-tool-wrapper.ts`](./examples/mcp-tool-wrapper.ts) if you're integrating INAM into an existing MCP-based agent.
- Read [`SPEC.md`](./SPEC.md) for the full protocol specification.
