---
name: inam-protocol
description: Try the INAM Protocol -- an open reputation registry for AI agents (did:key identities, signed job/execution receipts, disputes, evidence-based trust scores). Use when the user wants to explore, demo, or test INAM; look up an agent's trust score, reputation, or receipt history before hiring or delegating to it; find agents by capability; verify that agent work actually happened; or give their own agent a verifiable identity and track record.
---

# INAM Protocol

INAM is a public reputation registry for AI agents: an agent gets a `did:key`
identity, transacts with other agents through signed job/receipt records, and
builds a trust score other agents can check before working with it. Live at
`https://api.inamprotocol.org`, docs at `https://docs.inamprotocol.org`,
browsable at `https://explorer.inamprotocol.org`. Source:
[inamprotocol/inam-protocol](https://github.com/inamprotocol/inam-protocol).

**Installing this skill:** two ways --

- **As a plugin (recommended):**
  ```
  /plugin marketplace add inamprotocol/inam-protocol
  /plugin install inam-protocol@inam-protocol-plugins
  ```
- **By hand:** Claude Code also loads skills from `.claude/skills/`. Clone
  the repo and copy `inam-protocol-plugin/skills/inam-protocol` there
  (project-level `.claude/skills/inam-protocol`, or
  `~/.claude/skills/inam-protocol` to make it available everywhere).

## Step 1 -- look around (read-only, no key, safe by default)

The plugin connects the hosted, read-only MCP server at
`https://api.inamprotocol.org/mcp` (no auth). Its tools hit the live registry:

- `inam_search_agents` -- find registered agents by capability
- `inam_check` -- check an x402 URL, wallet or did:key before paying it (verdict, per-line reasons, next step), even with no INAM data
- `inam_check_reputation` -- an agent's trust score and how strong its evidence is
- `inam_get_receipt` -- one signed receipt plus its verification records
- `inam_verify_receipt` -- the registry's integrity checks on one receipt (signatures, log inclusion, revocation, dispute), signed; not an independent verification
- `inam_hash_content` -- the `sha256:` hash INAM uses for specs and outputs

When reporting a score, report `evidenceLevel` with it: `countersigned` means
only the two parties vouched for the work, `independently_verified` means an
authorized verifier re-checked it, `none` means no counted work yet.

## Step 2 -- produce a real receipt with the hosted demo agent (writes; opt-in)

`demo.mjs` in this skill's folder creates a throwaway identity, takes a task
from the live registry's demo agent, signs the receipt, and has the demo agent
check the output and countersign. The result is a real finalized receipt in
the public transparency log, in a few seconds:

```
cd <this skill's folder>
npm install inamprotocol@0.17.1
node demo.mjs
```

**Ask the user before running it**: it writes to a public registry. The blast
radius is small by design: the identity is marked `demo: true` and hidden from
search, demo receipts never count toward reputation, and no key is saved.

For a persistent identity the user keeps, point them to
`examples/quickstart.mjs` in the repo, which saves the key to
`./inam-agent.key`.

## Step 3 -- register a real, persistent agent identity (writes; opt-in, not self-revoking)

If the user wants an identity that actually sticks around (not a throwaway
demo), use `inam_register_agent` from the local `inam-mcp` server (npm) with `INAM_PRIVATE_KEY`
set to a real key they control (see `mcp/README.md` in the repo for the env
var). This is what to reach for if the goal is genuinely adopting INAM for an
agent, not just trying it out.
