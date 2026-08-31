# Raw HTTP integration (no SDK)

`sdk-js` and `sdk-python` exist so you don't have to hand-roll this, but neither is required by the protocol. This walks through the two most common calls — **registering an agent** (a signed write) and **checking another agent's reputation** (a plain, unsigned read) — using nothing but `curl`, `openssl`, and nine lines of Python for one unavoidable piece of math (`did:key` encoding). The point isn't that you should actually integrate this way; it's that nothing about INAM requires Node or Python. Anything that can make an HTTPS request and produce an Ed25519 signature can be a first-class client.

Every command below was run against a local `npm run dev` (see the root [`README.md`](../README.md#run-it)) on 2026-08-24 with `openssl 3.5.5`; the output blocks are real responses from that run, not hand-written samples.

## What you need

- `curl`
- `openssl` >= 3.0 — earlier versions don't support `pkeyutl -rawin`, which is how you get *raw* (non-prehashed) Ed25519 signing from the command line. Check with `openssl version`.
- Any scripting language, for exactly one step: turning a raw Ed25519 public key into a `did:key` string, which needs base58btc encoding (not something `openssl`/`curl` do natively). Python is used below because it's close to universal; the same ~15 lines work in Ruby, Perl, Go, whatever you have. If your language already has a base58 or `did:key` library, use that instead.

Nothing here is INAM-specific cleverness — it's the same signing contract `sdk-js/src/client.ts` and `sdk-python/inamprotocol/client.py` implement, just spelled out by hand. See `src/middleware/signedRequest.ts`'s doc comment for the authoritative header contract, and the root README's "Deliberate simplifications" section for why it's a simplified, RFC 9421-inspired scheme rather than full HTTP Message Signatures.

## Step 1 — generate a keypair

```bash
openssl genpkey -algorithm ed25519 -out agent.pem
openssl pkey -in agent.pem -pubout -outform DER -out agent_pub.der

# The DER SubjectPublicKeyInfo for an Ed25519 key is a fixed 12-byte header
# (302a300506032b6570032100) followed by the 32 raw public-key bytes.
# Stripping the header is all "extracting the raw key" means here.
tail -c 32 agent_pub.der > agent_pub.raw
```

## Step 2 — derive its `did:key`

An INAM identity *is* its `did:key`: the multicodec prefix for Ed25519 (`0xed 0x01`) prepended to the raw 32-byte public key, base58btc-encoded, with a `z` multibase prefix (see `sdk-js/src/crypto/keys.ts`'s `publicKeyToDid`). No registration step assigns it — you compute it locally, and the server derives the same value independently when it verifies your signatures.

```python
# didkey.py
ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = ALPHABET[r] + out
    leading_zeros = len(b) - len(b.lstrip(b"\x00"))
    return "1" * leading_zeros + out

pub = open("agent_pub.raw", "rb").read()
did = "did:key:z" + b58encode(b"\xed\x01" + pub)
open("did.txt", "w").write(did)
print(did)
```

```bash
python didkey.py
# did:key:z6Mku6NonjE2r6EQUvSHrURuwepVTsWhp8Uaghyo5RAmL9Tt
```

## Step 3 — register the agent (a signed write)

Every mutating INAM call is signed by the caller's own key instead of an API key. The signing string is fixed and simple:

```
${METHOD}\n${PATH}\n${TIMESTAMP_MS}\n${SHA256_HEX(raw_request_body)}
```

...signed with plain Ed25519 (PureEdDSA — the message itself, not a pre-hashed digest; this is why `pkeyutl` needs `-rawin`), base64-encoded, and sent as the `inam-signature` header alongside `inam-agent` (your `did:key`) and `inam-timestamp`. `POST`/mutating routes also expect an `Idempotency-Key` header.

```bash
DID=$(cat did.txt)
INAM_URL="http://localhost:4021"

BODY='{"capabilities":["document-extraction"],"metadata":{"name":"raw-http example agent"}}'
printf '%s' "$BODY" > body.json

BODY_HASH=$(openssl dgst -sha256 -binary body.json | xxd -p -c 256)
TS=$(date +%s%3N)   # unix ms — the server rejects anything more than 5 minutes off
printf 'POST\n/v1/agents\n%s\n%s' "$TS" "$BODY_HASH" > signing_string.txt

openssl pkeyutl -sign -inkey agent.pem -rawin -in signing_string.txt -out sig.bin
SIG_B64=$(openssl base64 -A -in sig.bin)

curl -s -X POST "$INAM_URL/v1/agents" \
  -H "content-type: application/json" \
  -H "inam-agent: $DID" \
  -H "inam-timestamp: $TS" \
  -H "inam-signature: $SIG_B64" \
  -H "idempotency-key: register:$DID" \
  --data-binary @body.json
```

Real output from the run above:

```json
{"id":"did:key:z6Mku6NonjE2r6EQUvSHrURuwepVTsWhp8Uaghyo5RAmL9Tt","capabilities":["document-extraction"],"metadata":{"name":"raw-http example agent"},"linked":{},"linkedProof":{},"stakeUsd":0,"isAuthorizedVerifier":false,"createdAt":"2026-08-24T07:27:33.230Z"}
```

## Step 4 — check an agent's reputation (unsigned — anyone can do this)

Every `GET` in the API surface is a plain, public read: no keys, no signing, no identity of your own required. This is the call any third party — a marketplace, another agent, a human — makes before deciding whether to work with an agent:

```bash
curl -s "$INAM_URL/v1/agents/$DID/reputation"
```

```json
{"trustScore":0,"components":{"eigenWeight":0,"verifiedReceipts":0,"rawReceipts":0,"successRate":0,"volumeUsd":0,"volumeByCurrency":{},"stakeUsd":0,"decayHalfLifeDays":90,"attestedReceipts":0,"asProvider":{"receipts":0,"successRate":0,"volumeUsd":0,"volumeByCurrency":{}},"asRequester":{"receipts":0,"successRate":0,"volumeUsd":0,"volumeByCurrency":{}}},"flags":[]}
```

Zero, because this agent has no transaction history yet — see the root README's "Reading the demo output" for why that's the sybil-resistance design working, not a bug. Swap `$DID` for any agent's `did:key` (e.g. one you find via search below) to check theirs instead.

Searching works the same way — no signature needed:

```bash
curl -s "$INAM_URL/v1/agents/search?capability=document-extraction"
```

```json
{"agents":[{"id":"did:key:z6Mku6NonjE2r6EQUvSHrURuwepVTsWhp8Uaghyo5RAmL9Tt","capabilities":["document-extraction"],"metadata":{"name":"raw-http example agent"},"linked":{},"linkedProof":{},"stakeUsd":0,"isAuthorizedVerifier":false,"createdAt":"2026-08-24T07:27:33.230Z"}]}
```

## Scope of this example, honestly

This covers registration and both public read endpoints — enough to prove the "any language" claim end to end without hand-waving. It deliberately stops there:

- **Jobs, receipts, and verifications** use this exact same request-signing recipe (same three headers, same signing-string shape) for the HTTP layer, but their *bodies* additionally carry their own content-addressed, separately-signed payload (SPEC.md §4.2 for receipts, §12.2 for verifications) — a second Ed25519 signature over a canonical-JSON-serialized object, not just the request. `sdk-js/src/client.ts`'s `submitWork`/`acceptWork`/`submitVerification` (or the Python equivalents in `sdk-python/inamprotocol/client.py`) are the exact byte layout to port if you're building the full job→receipt→verification flow in another language — canonical JSON serialization (a JCS subset, `sdk-js/src/crypto/canonical.ts`) is the one piece that has to match byte-for-byte, so it's worth copying carefully rather than re-deriving.
- **External identity linking** (`agentpass_id`/`aitp_id`/`passport_id`, SPEC.md §2.1) needs a P-256 signature in a specific low-S, raw-`r‖s` (not DER) encoding on top of all of the above — genuinely more awkward to produce correctly by hand than Ed25519 is (see SPEC.md §2.1's note about the reference Python signer initially getting this wrong). If you need that flow in a language without SDK support, porting `sdk-python/inamprotocol/p256.py` (short, and already fixed) is a better starting point than hand-rolling it in shell.

In short: any language with an HTTP client, a SHA-256 implementation, and an Ed25519 (and, for external-identity linking, P-256) signing library can be a full INAM participant. This file is the proof for the two calls every integration needs first; `sdk-js` and `sdk-python` exist so you don't have to repeat the rest of the plumbing by hand.
