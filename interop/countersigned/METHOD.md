# Grounding method: `counterparty-countersigned`

A label for feedback or validation records, defined here without reference to any one registry. Written for the label discussions in [erc-8004-contracts#99](https://github.com/erc-8004/erc-8004-contracts/issues/99) and [x402#3772](https://github.com/x402-foundation/x402/issues/3772). The reference implementation is INAM Protocol; section numbers below are INAM's `SPEC.md`.

## What it asserts

Two keys, the provider's and the requester's, each signed the same content, which includes `task.specHash` and `result.outputHash` (§4.1, §4.3). Both are `sha256:` of actual bytes (§4.1, hash format). Signatures are Ed25519 over the canonical content (§4.2, §4.3).

Over an HTTP call (§15), `specHash` is the hash of `METHOD SP path[?query] LF` plus the exact request body, and `outputHash` is the hash of the exact response body. The requester recomputes both from the bytes it sent and received and must not sign unless they match (§15 step 3). So a valid record says: the requester key attests that these are the bytes it saw for this request.

## What it does not assert

- That the interaction happened. A requester and a provider can sign hashes of bytes that were never exchanged over a network.
- That payment occurred. `settlement.paymentRef` is an optional pointer to another rail and is not verified (§4.1). The method is independent of `x402-settlement` and can be combined with it.
- That the parties are independent. Two keys controlled by one operator can produce a valid record. INAM's anti-collusion measures (§5.2 weighting, §12 verifier grants) are registry policy, not part of this method.
- Quality of the output (§15, closing paragraph). The outcome value is the parties' declaration.
- That the requester key is the wallet that posts the feedback; that is a separate check (below).

## What a consumer must check

The checks in `verify.mjs`, each of which fails closed:

1. `feedbackHash` equals keccak256 of the feedback file bytes.
2. `receiptId` equals `sha256` of the canonical content (§4.2).
3. Provider and requester signatures both verify against the DIDs in the receipt.
4. `value` matches the declared outcome (100 / 50 / 0 for success / partial / failed, §11.1 step 2).
5. The file's `clientAddress` equals the sending address, and that address is the requester's proven wallet link (§2.1, §11.1 step 4). This defeats copying a genuine file to another wallet.
6. If the consumer holds the observed bytes, both hashes recompute from them. Without the bytes, checks 1 to 5 still pass for a fabricated pair of hashes.

Not covered by the fixtures, and needing live state (§11.1 step 4): the registry reports the receipt `finalized` and not disputed, and the ERC-8004 `agentId` belongs to the provider.

## The amount is not bound by the signed content

The signed receipt binds the outcome (`verification.outcome`), not an amount. `value` is derived from the outcome (100 / 50 / 0) and sits in the feedback file and the on-chain event, outside the signed content. Check 4 therefore catches an inflated `value` only for a checker that reads the receipt's outcome (`INFLATED-VALUE`). Where a receipt carries no outcome or no `settlement` evidence, nothing in the signed content constrains the amount: a checker that lacks an outcome to compare against, or a case where one party controls both the file and the event, leaves it riding on the file hash alone. Binding the amount to a payment needs settlement evidence checked against the chain (for example an x402 settlement), which this method does not require. Reported by holistis on x402 [#2887](https://github.com/x402-foundation/x402/issues/2887), who mutated the positive vector twelve ways.

## What is public when used in a feedback file

Per §11.1, only a `finalized`, `public` receipt may be published. The file then exposes: the requester's wallet (`clientAddress`), both DIDs, `task.capability`, `specHash`, `outputHash`, the verification outcome, both signatures, and, if the parties included them, `settlement.paymentRef`, `amount` and `currency`. Hashes reveal nothing about content to someone who does not already hold it, but low-entropy inputs can be guessed and checked.

## Verifying independently

Requires Node only (built-in `crypto`, no install, no INAM server):

```sh
node interop/countersigned/verify.mjs
```

It prints PASS or FAIL per case and exits 1 on any mismatch. `vectors.json` holds five cases (`POSITIVE`, `WRONG-WALLET-COPY`, `TAMPERED-OUTPUT-HASH`, `OUTPUT-NOT-WHAT-WAS-SERVED`, `INFLATED-VALUE`), the observed request and response bytes, the parties, and for each case `expected.accepted` and `expected.failedChecks`. To rebuild the vectors with the INAM SDK: `npx tsx interop/countersigned/generate.ts`.

A second implementation in another language reads `vectors.json`, runs the checks above for each case, and compares `accepted` and the exact list of failed check names to `expected`. The parts that need care are: the canonical serializer (sorted keys by UTF-16 code unit, no whitespace; shared vectors in `interop/canonical/vectors.json`; this is a subset of RFC 8785, §4.2), Ed25519 verification from a `did:key`, and Keccak-256 (Ethereum's padding, not NIST SHA3-256). `verify.mjs` is about 100 lines and is the reference for each.

## Known limits

- Test keys. The vector keys derive from public strings in `generate.ts`; anyone can sign as them. The EVM addresses are invented.
- The registry is run by its operators, and the weighting that discounts low-reputation counterparties (§5.2) is applied by them. INAM states it is not trustless (§0, §11.1 last paragraph). A reader who needs a finding re-derives it from signed records (§5.4).
- Evidence of use, from the registry's own `GET https://api.inamprotocol.org/v1/stats` on 2026-10-17: 0 non-operator agents, 0 countersigned receipts between independent parties, 13 countersigned receipts, 11 of them labelled test or demo. The method is specified and checkable; it has no independent real-world usage yet.
- One implementation exists. Whether a second one agrees on inputs outside the vectors (for example non-integer numbers in the canonical form) is untested.
