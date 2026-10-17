# Counterparty-countersigned feedback: signed vectors

INAM grounds a rating in a **counterparty countersignature over the work**: the provider signs a receipt naming `task.specHash` and `result.outputHash` (both `sha256:` of the actual bytes), then the requester signs the same canonical content ([SPEC §4](../../SPEC.md#4-execution-receipt)). Over an HTTP call, both hashes are derived from the request and response bytes ([§15](../../SPEC.md#15-receipts-over-http-v041)). The finalized receipt goes into ERC-8004 `giveFeedback` as in [§11.1](../../SPEC.md#111-inam-and-erc-8004). It needs no payment to be visible on-chain, so it composes with `x402-settlement` instead of replacing it.

These vectors are offered for the grounding conformance set discussed in [erc-8004-contracts#99](https://github.com/erc-8004/erc-8004-contracts/issues/99) and [x402#3772](https://github.com/x402-foundation/x402/issues/3772).

```sh
node interop/countersigned/verify.mjs     # Node built-ins only, no INAM server, no npm install
```

## Cases (`vectors.json`)

| Case | What changes | Must be rejected by |
|---|---|---|
| `POSITIVE` | nothing: genuine feedback, right wallet, hashes match the observed bytes | accepted |
| `WRONG-WALLET-COPY` | the genuine file, byte for byte, sent from another wallet | `fileClientAddressMatchesSender`, `senderIsRequesterWallet` |
| `TAMPERED-OUTPUT-HASH` | `result.outputHash` edited in the carried receipt; `feedbackHash` recomputed over the edited file | `receiptIdRecomputes`, both signatures, `outputHashMatchesObservedBytes` |
| `OUTPUT-NOT-WHAT-WAS-SERVED` | both signatures valid, but the provider's `outputHash` commits to bytes the requester never received | `outputHashMatchesObservedBytes` |
| `INFLATED-VALUE` | `value` raised 100 to 999 in file and event, `feedbackHash` recomputed; receipt untouched | `valueMatchesOutcome` |

The last case is the one the countersignature rule exists for. A requester that recomputes both hashes from the bytes it observed (SPEC §15 step 3) refuses to sign; a requester that signed anyway produces a record every signature check accepts and only the binding check catches. That recomputation is a verification step, not a second derivation of the interaction's identity: nothing is re-derived, the requester compares its own bytes against the value the provider derived.

## Independent implementation

[agent-receipt-verify](https://github.com/holistis/agent-receipt-verify) (by holistis, not affiliated with this project) is an independent implementation, written from SPEC.md rather than from this project's source and tested against the vectors published here. It covers countersigned receipts: content addressing, both signatures over the canonical content, and the hashes against the bytes a counterparty observed. Reported results: 4 of 4 countersigned cases at `d5e5f45` with identical failed-check sets (the `INFLATED-VALUE` case was added later and is not in that count), and 10 of 10 on `interop/canonical` at `d4a2940`. Node built-ins, no network, no keys. It checks the form of a receipt, not whether an operator is honest. Source: x402 [#2887](https://github.com/x402-foundation/x402/issues/2887).

## What each check does

`feedbackHashMatchesFile` keccak256 of the file bytes equals the event's `feedbackHash`. `receiptIdRecomputes` content-addressing (§4.2). `workerSignature` / `requesterSignature` Ed25519 over the same canonical content (§4.3). `valueMatchesOutcome` 100 / 50 / 0 for success / partial / failed. `fileClientAddressMatchesSender` the file names the address that sent the event. `senderIsRequesterWallet` that address is the `linked.erc8004_id` the requester's INAM ID proved control of (here the fixture's stand-in for the registry lookup). `specHashMatchesObservedBytes` / `outputHashMatchesObservedBytes` the hashes equal `sha256` of the request (`METHOD path?query\n` + body) and response bytes in `observed`.

`verify.mjs` includes a small Keccak-256 because Node ships none; `tests/countersignedInterop.test.ts` checks it against the SDK's.

## Files

| File | What it is |
|---|---|
| `vectors.json` | The five cases, the observed request/response bytes and the parties. |
| `verify.mjs` | The independent check. Prints PASS/FAIL per case. |
| `generate.ts` | Rebuilds `vectors.json` byte for byte with the INAM SDK (`npx tsx interop/countersigned/generate.ts`). |

**Test keys.** Both DIDs come from private keys derived from public strings in `generate.ts`; anyone can sign as them. The EVM addresses are made up and are not derived from any key. They exist only for these fixtures.

**Not covered.** The registry's view of the receipt (status `finalized`, not disputed) is outside these files, and so is checking that the ERC-8004 `agentId` belongs to the provider; both need live state ([§11.1](../../SPEC.md#111-inam-and-erc-8004) step 4). INAM's registry is run by its maintainers, so these vectors test the format and the checks, not that anyone should trust the operator.
