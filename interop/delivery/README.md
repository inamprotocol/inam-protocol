# Delivery receipts as dispute evidence: signed vectors

A delivery receipt is an INAM receipt over an HTTP call ([SPEC §15](../../SPEC.md#15-receipts-over-http-v041)). The seller signs `sha256` of the exact request bytes (`task.specHash`) and response bytes (`result.outputHash`). The buyer's agent recomputes both from what it observed and countersigns only if they match. These vectors are for a dispute reader that weighs such a receipt. They follow the rule proposed for ACP's dispute-resolution extension ([SEP #303](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/discussions/304), [#316](https://github.com/agentic-commerce-protocol/agentic-commerce-protocol/pull/316)):

> A receipt countersigned by the buyer with matching hashes weighs against a non-delivery or wrong-content claim. A missing countersignature decides nothing on its own. It shows which bytes arrived, not whether they met the agreed criteria.

```sh
node interop/delivery/verify.mjs     # Node built-ins only, no INAM server, no npm install
```

## Cases (`vectors.json`)

| Case | What it is | Verdict | Failed checks |
|---|---|---|---|
| `VALID-COUNTERSIGNED` | Seller signed the hashes of what it served; the buyer recomputed and countersigned | `weighs-against-claim` | none |
| `HASH-MISMATCH` | Both signatures valid, but `outputHash` commits to bytes the buyer never received | `not-these-bytes` | `outputHashMatchesObserved` |
| `SELLER-ONLY-DRAFT` | The seller's draft over the right bytes, never countersigned | `decides-nothing` | `buyerSignature` |

A broken seller signature or a `receiptId` that does not recompute is `invalid` (tested in `tests/deliveryInterop.test.ts`).

## Reproducing the bytes

- **Content and signatures.** Each party signs the receipt without `signatures`, `status`, `dispute` and `visibility`, serialized with RFC 8785 (JCS). Any conforming RFC 8785 implementation reproduces the bytes for this I-JSON content ([§4.2](../../SPEC.md#42-receipt-id-content-addressing); `tests/jcsEquivalence.test.ts` checks INAM's serializer against one). `receiptId` is `sha256:` of the same serialization without `receiptVersion` and `receiptId`.
- **Keys.** Ed25519, public key taken from each party's `did:key`.
- **Hashes.** `specHash` = `sha256(METHOD + " " + path?query + "\n" + request body)`, and `outputHash` = `sha256(response body)`. Both are taken over the bytes in `observed`.

`generate.ts` rebuilds `vectors.json` byte for byte with the INAM SDK (`npx tsx interop/delivery/generate.ts`).

**Test keys.** Both DIDs come from private keys derived from public strings in `generate.ts`, so anyone can sign as them. They exist only for these fixtures.

**Not covered.** Whether the bytes met the agreed criteria. Whether the seller's key belongs to the merchant of record. Payment: INAM never moves or verifies money.
