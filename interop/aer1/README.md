# AER-1: a reader written from the draft text alone

[AER-1](https://www.ietf.org/archive/id/draft-zambo-aer1-26.txt) (`draft-zambo-aer1-26`) is another receipt format: a record commits to the exact output bytes with `output_hash`, and job timelines are hash chains. It ships a conformance corpus of 143 vectors. This folder holds a reader that was written from the text of the draft only (Sections 3 to 7). The kit's own runners were not read or run. It was run against the corpus on 2026-11-21 (kit 1.5.7), and the result was reported in [HKUDS/nanobot#6028](https://github.com/HKUDS/nanobot/discussions/6028).

It is not an INAM adapter. An AER-1 record carries no signature, so there is no issuer key to carry into an INAM receipt the way [`examples/agent-receipts-adapter.ts`](../../examples/agent-receipts-adapter.ts) does. `output_hash` would map directly to `result.outputHash`, because both are SHA-256 over exact bytes. That mapping has not been built.

```sh
node interop/aer1/fetch.mjs /tmp/aer1       # downloads the corpus, checks every sha256 and the set digest
node interop/aer1/reader.mjs /tmp/aer1      # records, draft text only
node interop/aer1/inferred.mjs /tmp/aer1    # records, plus the rules inferred from the corpus
node interop/aer1/chain.mjs /tmp/aer1       # v07 chains and chain commitments, draft text only
```

Node 22 or later, built-ins only. The corpus is downloaded, not stored here.

## Result (93 of the 143 vectors)

| Family | Vectors | Agree with the corpus |
|---|---|---|
| Chain (`chain-vectors-v07.json`) | 28 | 28 |
| Chain commitment | 8 | 7 |
| Records (`valid/`, `invalid/`), draft text only | 57 | 42 |
| Records, with the inferred rules | 57 | 57 |

Not covered: anchors, Merkle, workflow, id-binding, unicode, the -06 chain file, `invalid-profile`.

## Where the draft text and the corpus differ

1. **`0.4` without `metadata_hash`.** Section 6 step 4 says such a receipt MUST fail. Ten vectors in `valid/` are 0.4 with no `metadata_hash`.
2. **Payload binding.** The corpus compares the outer `provenance_class` and `receipt_schema_version` with `issuer_claims.provenance_class` and `receipt_schema_version` inside the decoded canonical bytes. The draft does not mention `issuer_claims`.
3. **Empty tool strings.** Rejected by the corpus. The draft requires non-empty strings for chain entries (7.2), not for a receipt's `tool`.
4. **Bare-string `tool`.** Step 4 allows it for a 0.3 receipt without `metadata_hash`. The corpus rejects one such vector and accepts another that also has a `tool_context` member.
5. **`verification_status`.** `"unverified"` is rejected, `"not_verified"` is accepted. The draft gives a verifier no rule for this member.
6. **`entry_count: 5.0`** is rejected, while 7.1 says `1` and `1.0` are equivalent for `seq`.

Six of the 42 agreeing record vectors agree for the wrong reason: `reader.mjs` fails them on point 1 before it reaches the check they were built for. `inferred.mjs` applies the rules above as inferred from the vectors' `rejected_by` strings, and reaches 57 of 57. The corpus is consistent with itself; the gap is between the draft text and the kit. The draft's author confirmed points 1 and 2 against the served files and said the text will not be revised, so the corpus governs.
