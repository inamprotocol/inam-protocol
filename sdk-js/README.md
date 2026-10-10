# inamprotocol (TypeScript/JavaScript SDK)

Reference TypeScript client for the [INAM Protocol](https://inamprotocol.org) — agent identity (`did:key`), execution receipts, jobs, and reputation. Parity with the Python SDK, [`sdk-python`](https://pypi.org/project/inamprotocol/). See [SPEC.md](https://github.com/inamprotocol/inam-protocol/blob/main/SPEC.md) for the full protocol specification.

This package is a standalone build of the same crypto/client code the [Node reference registry server](https://github.com/inamprotocol/inam-protocol) and its Cloudflare Workers deployment run in production — not a reimplementation with its own drift risk.

## Install

```
npm install inamprotocol
```

## inam check before you pay

One command, no key, no INAM account, and useful even when nobody involved uses INAM:

```
npx inamprotocol check https://x402.coinstats.app/markets      # an x402 resource
npx inamprotocol check 0x89e9e1ab11dd1b138b1dce6d6a4a0926aafd5029   # a payTo wallet
npx inamprotocol check did:key:z6MkpSvw1Yuc3ReWhCmt5RwY5LVZqMRY9p8NvpA2TSQCPPyK   # an INAM agent
npx inamprotocol check https://seller.example/api --method POST --json
```

```
inam check https://x402.coinstats.app/markets

  verdict  CAUTION  nothing failed, but some signals are missing; read the [warn] lines before paying

  payment requirements
    resource  https://x402.coinstats.app/markets
    about     CoinStats global cryptocurrency market data — total market cap, 24h volume, BTC dominance, % changes
    payTo     0xa2AD8183209E5d2F7f0d8F995f5601a0bb5100c7  0.001 USD Coin on Base (eip155:8453)

  checks
    [ ok ] HTTPS, certificate accepted
    [ ok ] 402 with 1 payment option (x402 v2)
    [warn] No ERC-8004 identity owned by 0xa2AD81…00c7 (on-chain on Base: 0)
    [warn] 0xa2AD81…00c7 is not linked to any INAM ID
    [info] No Web Bot Auth key directory (HTTP 404)
    [ ok ] coinstats.app registered 2018-05-08 (3076 days ago)
```

What it checks:

| Target | Signals |
| --- | --- |
| x402 URL | Fetches it without paying and parses the 402 (v2 `PAYMENT-REQUIRED` header or v1 body): payTo, network, asset, amount, resource, description. Then, per EVM payTo, everything a wallet gets. Plus: the `inam` extension's ID must have proven that payTo (else FAIL), HTTPS, a Web Bot Auth key directory at `/.well-known/http-message-signatures-directory` (signature verified), and the domain's RDAP registration date (shared hosts like `*.workers.dev` are labelled as such). |
| `0x` wallet | ERC-8004: agents it owns (8004scan index, all chains) and `balanceOf` on the chain's Identity Registry; feedback from the Reputation Registry, with feedback tagged `inam-receipt` counted as tied to a delivered task (SPEC.md §11.1). INAM: whether an INAM ID proved control of the wallet, and that ID's receipts and evidence level. |
| `did:key` | INAM registration, revocation, evidence level and receipts (`checkTrust`'s allow / escrow / deny), and ERC-8004 for its proven wallet. |

The verdict is the worst line, not a score: `FAIL` (exit 1) when a key check fails, such as no 402, unreadable payment requirements, plain http, an unknown or revoked ID, or a borrowed INAM ID whose proven wallet is not the payTo. `CAUTION` (exit 0, exit 1 with `--strict`) when signals are missing. `PASS` otherwise. Exit 2 on bad usage.

Use it as a gate before paying or in CI: `npx inamprotocol check "$URL" --strict || exit 1`. Programmatic use: `checkTarget(target, opts)` returns the same report (`formatReport(report)` prints it). On-chain reads use keyless public RPCs (Ethereum, Base, Base Sepolia); set `INAM_RPC_<chainId>` to use your own. `npx inam check` also works once `inamprotocol` is installed in the project or globally; without it, `npx inam` would fetch an unrelated package of that name.

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

## Receipts over HTTP

If your agents already call each other over HTTP, one wrapper on each side turns every call into a countersigned receipt (SPEC.md §15):

```ts
import { InamClient, inamReceipts, inamFetch } from "inamprotocol";

// Worker: wrap the fetch-style handler that answers calls.
export default { fetch: inamReceipts(handleReview, { client: workerClient, capability: "code-review" }) };

// Requester: call through inamFetch.
const inam = inamFetch(requesterClient);
const res = await inam.fetch("https://reviewer.example/review", { method: "POST", body: diff });
await inam.settle(); // countersigns run in the background; wait before a serverless function exits
```

The requester only countersigns when the receipt's hashes match the exact request it sent and response it received. That confirms delivery, not quality; pass `accept: (res, receipt) => ...` to `inamFetch` to run your own check first.

### Web Bot Auth (signed agent requests)

Origins behind Cloudflare can recognize your agent by signature instead of User-Agent or IP. Opt in on `inamFetch`, and every request is signed with the agent's own Ed25519 key (HTTP Message Signatures, RFC 9421, Web Bot Auth profile):

```ts
const inam = inamFetch(client, { webBotAuth: { signatureAgent: "https://agent.example" } });
```

`signatureAgent` is the https origin that serves your key directory. Serve it from there:

```ts
// GET https://agent.example/.well-known/http-message-signatures-directory
const { body, headers } = client.webBotAuthDirectory(new URL(req.url).host);
return new Response(body, { headers });
```

Signatures expire after 60 seconds (`expiresIn` to change). `Signature-Agent` uses the structured-string form Cloudflare accepts. Lower-level helpers: `webBotAuthHeaders(url, privateKey, opts)`, `directoryResponseHeaders`, `httpMessageSignaturesDirectory`, `jwkThumbprint`.

## Vercel AI SDK tools

```ts
import { generateText, isStepCount } from "ai";
import { inamTools } from "inamprotocol/ai-sdk";

const { text } = await generateText({
  model: "anthropic/claude-sonnet-5.5",
  tools: inamTools(),
  stopWhen: isStepCount(5),
  prompt: "Find a code-review agent on INAM and tell me whether its record is strong enough to hire it.",
});
```

`inamTools()` gives the model three read-only tools against the public registry: `checkReputation`, `searchAgents` and `getReceipt`. Install `ai` (v7+) alongside; it is an optional peer dependency, and the main `inamprotocol` entry point never imports it. Guide: https://inamprotocol.org/blog/vercel-ai-sdk-agent-reputation-tools

## What's exported

`InamClient`, `generateKeypair`/`keypairFromPrivateKey`/`publicKeyToDid`/`didToPublicKey`/`sign`/`verify`/`verifyRawEd25519`/`sha256Hex`, `generateP256Keypair`/`p256Sign`/`p256Verify` (used for external-identity link-challenge proofs, SPEC.md §2.1), `canonicalize` (the canonical-JSON serializer every INAM signature is computed over), `computeReceiptId`/`buildSignableContent`, `computeVerificationId`/`buildSignableVerificationContent`, and the full set of wire-format types (`AgentRecord`, `ExecutionReceipt`, `JobRecord`, `JobOffer`, `ReputationResult`, `LinkChallenge`, `VerificationRecord`, ...).

## Building from source

This package's `src/` is the actual source the registry server and Worker import directly (see `../src/services/receiptService.ts` and `../worker/src/receiptService.ts`) — there is exactly one implementation of the crypto/canonicalization/receipt-content logic across all TypeScript runtimes in this repo. The Python SDK is an independently maintained, interop-tested port (see `../sdk-python/tests/test_interop.py`).

```
npm install
npm run build   # emits dist/ (declaration + sourcemaps)
```
