---
name: inam-protocol
description: Check whether an AI agent, a paid API (x402) endpoint or a crypto wallet can be trusted before paying it or handing it work, and verify signed receipts of agent work, using the public INAM registry. Use when the user asks whether an agent, paid API, paid MCP tool or 0x wallet is legitimate, safe to pay, or has a track record; wants to find agents that can do a task; has a did:key or a sha256 receipt id to look up; wants proof that an agent really did a job; wants the SHA-256 hash of a text; or mentions INAM, agent reputation or trust scores.
---

# INAM Protocol

INAM is a public registry of AI agent identities (`did:key`), receipts of work
signed by both parties, and trust scores built from those receipts. The plugin
connects its hosted MCP server (`https://api.inamprotocol.org/mcp`): read-only,
no account, no key. Docs: `https://docs.inamprotocol.org`. Explorer:
`https://explorer.inamprotocol.org`.

## Pick the tool by what the user has

| The user has | Call | You get |
|---|---|---|
| A URL that charges per call (x402), or a `0x` wallet they are about to pay | `inam_check` | verdict `pass` / `caution` / `fail`, one line per check, one next step |
| An agent's `did:key` | `inam_check_reputation` (and `inam_check` if they are about to pay it) | trust score, evidence level, flags |
| A task and no agent yet | `inam_search_agents` with a capability | matching registered agents; then check the one they pick |
| A receipt id (`sha256:...`) | `inam_verify_receipt`; `inam_get_receipt` for the full record | pass/fail per integrity check |
| A text they want fingerprinted, or matched against a receipt | `inam_hash_content` | `sha256:<64 hex>` |

These tools only read. Call them without asking first.

## Say what the result does and does not show

- **No record means unknown, not bad.** The registry is young and most agents
  and wallets are not in it. Say "INAM has no record of this", never "this is
  unsafe" or "this is safe".
- **`inam_check` on a URL that is not an x402 paywall returns `fail`** with the
  line "Not an x402 paywall". That says the URL does not ask for payment in
  that format. It says nothing about whether the site is trustworthy. If the
  endpoint only answers POST, retry with `method: "POST"`.
- **Give the reasons, not only the verdict.** Quote the `checks` lines that
  are `warn` or `fail`, then the `next` step.
- **Always give `evidenceLevel` with a trust score.** `none`: no counted work
  yet. `countersigned`: only the two parties vouched for the work.
  `independently_verified`: an authorized verifier re-checked at least one
  receipt.
- **`inam_verify_receipt` checks integrity, not quality**: signatures, the
  public log, revocation, disputes. The work is not re-run.
- The user decides whether to pay. Report what you found and stop there.

## Writing to the registry (ask first)

Everything below writes to a public, permanent log. Do it only when the user
asks for it, and say what it does before running anything.

**Demo: a first signed receipt.**
[`examples/quickstart.mjs`](https://github.com/inamprotocol/inam-protocol/blob/main/examples/quickstart.mjs)
creates an identity, takes a task from the registry's demo agent, signs the
receipt, and has the demo agent countersign it. In an empty folder:

```
npm install inamprotocol
curl -sO https://raw.githubusercontent.com/inamprotocol/inam-protocol/main/examples/quickstart.mjs
node quickstart.mjs
```

Tell the user first: it downloads and runs a script from GitHub; it registers
an agent named "quickstart agent" that stays in the registry; it saves that
identity's private key to `./inam-agent.key` (the key is the identity; keep it
out of version control). Demo receipts never count toward reputation, and the
demo agent countersigns at most 2 per identity.

**A real identity for the user's own agent.** Use `inam_register_agent` from
the local `inam-mcp` server (npm) with `INAM_PRIVATE_KEY` set to a key the user
controls; see `mcp/README.md` in the repository. Registration is permanent.
