# EMILIA Gate admission → INAM Execution Receipt

EMILIA Gate admits one exact action before it runs. An INAM Execution Receipt
([SPEC §4](../../SPEC.md#4-execution-receipt)) records afterwards that the
worker delivered it and the requester accepted it, with both parties' Ed25519
signatures. These fixtures join the two on the action bytes, with no schema
change on either side: the receipt's `task.specHash` is `sha256:` + the
SHA-256 of the admitted action's canonical bytes. Context:
[emiliaprotocol/emilia-protocol#895](https://github.com/emiliaprotocol/emilia-protocol/issues/895).

```sh
node interop/emilia/verify.mjs     # Node built-ins only, no INAM server, no npm install
```

## Files

| File | What it is |
|---|---|
| `consequence-admission-lifecycle-v0.1.vectors.json` | EMILIA's file, copied **unchanged** (byte-identical, git blob `c214f110`) from [`conformance/composition/consequence-admission-lifecycle-v0.1/vectors.json`](https://github.com/emiliaprotocol/emilia-protocol/blob/3f712d28b2cf624342bd98c4172e1a574b39644b/conformance/composition/consequence-admission-lifecycle-v0.1/vectors.json) at `emiliaprotocol/emilia-protocol@3f712d28b2cf624342bd98c4172e1a574b39644b` (last changed upstream in `32df1bf`). Apache-2.0, © the EMILIA Protocol authors. INAM is also Apache-2.0; see [`LICENSE`](../../LICENSE). |
| `receipt.json` | A finalized INAM receipt: worker and requester signatures over the same canonical content (§4.2–4.3). |
| `negative-action.json` | The admitted action with one byte changed (`amount` `"50.00"` → `"50.01"`). |
| `verify.mjs` | The independent check. Prints PASS/FAIL per case. |
| `generate.ts` | Rebuilds `receipt.json` and `negative-action.json` byte-for-byte with the INAM SDK (`npx tsx interop/emilia/generate.ts`). |

**Test keys.** Both DIDs in `receipt.json` come from private keys derived from
public strings in `generate.ts`. Anyone can sign as them. They exist only for
these fixtures.

## The action and the binding

The admitted action is `base_action` in EMILIA's suite. Case
`AUTHZEN-EXACT-ACTION-ADMITTED-ONCE` admits it once and refuses the replay
(`EXECUTED_THEN_REFUSED`). The suite's runner (`run.mjs` in the same upstream
directory) keys admission on `exact_action_digest` =
`sha256:` + hex SHA-256 of the action serialized with sorted keys and no
whitespace. For this action, those bytes are also RFC 8785 (JCS) output and
INAM's own `canonical()`:

```
{"action_type":"payment.release.1","amount":"50.00","currency":"USD","payee":"acct:merchant-42","provider_operation":"payments.transfer.create"}
specHash = sha256:bde15cf1602289ce7958f691061640b3c40d6926ce8b3c3bbb844bf170b10c1a
```

So `task.specHash` is the same value as EMILIA's `exact_action_digest`.

**Raw bytes or CAID?** These fixtures bind the raw canonical bytes. A CAID
(`canactid:1:<action_type>:jcs-sha256:<digest>`) is SHA-256 over the JCS bytes
of a typed action object with no domain-separation prefix, encoded as
base64url. For an action object that is valid under CAID, the CAID digest and
`specHash` are therefore the same 32 octets in two encodings, and a relying
party can join on either. This `base_action` has no CAID: CAID registry v5's
`payment.release.1` requires `beneficiary_account` and
`payment_instruction_id`, and this synthetic action carries `payee` and
`provider_operation` instead. Binding raw bytes is also what this suite's own
admission check compares.

## Cases

1. The copied EMILIA file is byte-identical to upstream (SHA-256 pin).
2. `base_action` is the action Gate admits in `AUTHZEN-EXACT-ACTION-ADMITTED-ONCE`.
3. Positive: `specHash` recomputes from that action, `receiptId` recomputes
   (§4.2), and both Ed25519 signatures verify from the `did:key`s.
4. The negative action differs from the admitted one by exactly one byte.
5. Negative: the same receipt checked against the one-byte-changed action is
   rejected. The signatures still verify, but the binding no longer matches.

## What this does not show

EMILIA's suite is a standalone, synthetic lifecycle model. Its README says it
does not run the shipped Gate package. Nothing here claims that Gate, or
EMILIA, verified this INAM receipt. The `outputHash` is the SHA-256 of the
string `EXECUTED`, a synthetic provider result. The binding under test is
`specHash` only. A countersigned receipt shows that the requester accepted
that output for that action. It does not show that the action was
authorized; that is EMILIA's receipt.

`tests/emiliaInterop.test.ts` runs `verify.mjs` and checks that `generate.ts`
reproduces the committed fixtures.
