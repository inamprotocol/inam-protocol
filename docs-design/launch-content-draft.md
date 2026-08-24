# Launch content — draft

Drafted for the maintainer's own review/editing before posting anywhere. Nothing in
this file has been posted. Facts below were checked against the repo as of
2026-08-24 (root `README.md`, `QUICKSTART.md`, `SPEC.md` §0/§11, `STATUS.md`,
`examples/mcp-tool-wrapper.ts`) — re-verify anything time-sensitive (test counts,
package versions, star/fork counts) before posting, since those drift.

Known facts used throughout, so they don't need re-deriving per section:
- Reference impl: Node/TS server, independent Cloudflare Worker deployment (Hono +
  D1 + KV), parity Python SDK. 92 automated tests total (38 Node vitest + 31 Worker
  vitest + 23 Python pytest), plus a cross-language interop test/demo.
- Live: `https://api.inamprotocol.org` (registry API), `https://docs.inamprotocol.org`
  (spec + Redoc API reference), `https://inamprotocol.org` (landing page).
- Published: `inamprotocol` on both npm and PyPI (source `sdk-js/` and `sdk-python/`).
- License: Apache-2.0. Repo: `github.com/inamprotocol/inam-protocol`.
- As of this writing: 0 GitHub stars/forks/issues, no external users. That's the
  premise for all of this content, not something to paper over.

---

## Where to post — candidate venues

Concrete places, not content — the maintainer picks which to actually use. I'm
flagging my confidence on each since some of this decays fast and I can't browse
live to re-check current posting rules.

- **Hacker News — "Show HN"** (`news.ycombinator.com`). High confidence this venue
  exists and is a fit — it's the canonical place for exactly this kind of post
  (working open-source infra, technical, first-person). No submission cost beyond
  an HN account.
- **r/AI_Agents** (Reddit). Reasonable confidence this subreddit exists and is
  actively focused on people building/using agents, which is a strong topical fit.
  Have not personally re-verified its current self-promotion rules — check the
  sidebar/wiki before posting, most agent-adjacent subs require disclosure of
  affiliation and cap how often you can post your own project.
- **r/MachineLearning** / **r/artificial**. Broader audience, much stricter and
  more variable about self-promotion posts historically (some require a "Discussion"
  framing rather than a link post, or route show-and-tell to a weekly thread) — lower
  confidence this lands well as a direct submission; if used, frame as discussion of
  the design ("how should sybil-resistant reputation work for agent-to-agent
  transactions") rather than a launch announcement.
- **GitHub "Awesome" lists** — `awesome-mcp-servers`, an `awesome-ai-agents` list,
  and DID/verifiable-credentials-focused lists (something like
  `awesome-decentralized-identity`). These categories of list genuinely exist on
  GitHub circa 2026 and most take PRs, but I have not verified the current specific
  repo names, maintainers, or PR-acceptance bar for any of them — search GitHub for
  the current canonical one in each category and read its own `CONTRIBUTING.md`
  before opening a PR (most want alphabetical placement, a one-line description
  matching their existing style, and no self-graded superlatives).
- **MCP community Discord**. `modelcontextprotocol.io` links to an official
  community Discord, and INAM already ships an MCP tool-wrapper example
  (`examples/mcp-tool-wrapper.ts`), which is a real fit for a "show and tell" /
  integrations channel there. Have not verified the current invite link or that
  channel's exact posting norms — confirm both before sharing.
- **lobste.rs**. Technical link aggregator with a "show" tag, good audience overlap
  with HN. Lower confidence this is usable as a first move: lobste.rs requires an
  existing member's invite to create an account at all, so this only applies if the
  maintainer (or someone they know) already has one.
- **dev.to**. Lower-ceiling but zero-friction: post a longer-form technical writeup
  (essentially the Show HN body, expanded) there for search/discoverability. No
  gatekeeping, but also less concentrated attention than the above.

---

## 1. "Show HN" post

**Title** (fits HN's ~80-char combined limit):

```
Show HN: INAM – signed execution receipts and reputation for AI agents
```

**Body:**

```
I built this because I kept running into the same gap: when two AI agents
transact — one hires another to do a task, pays it, gets an output back —
there's no way for anyone else (another agent, or a human deciding whether to
trust one) to check afterward that the work actually happened, went well, or
that either party has any track record. Five-star ratings are trivially
fakeable and tied to whatever platform issued them.

INAM's core primitive is the Execution Receipt: when two agents complete a
piece of work, both sign a canonical record of it — task, output hash,
settlement reference, verification outcome — and the receipt's own ID is a
hash of that content. So it can't be edited after the fact without
invalidating both signatures; the ID *is* the proof of what's in it. An
agent's reputation score is computed from its accumulated receipts, not
assigned by a platform.

The reputation math has a few sybil-resistance ideas baked in from the start,
because "just count receipts" is gameable: weighting by each counterparty's
own independently-computed trust, sub-linear weighting for pairs who transact
with each other a lot (so two colluding agents can't just farm score off one
another), time decay, and a flag for counterparty concentration. A brand-new
agent with two transactions against unknown counterparties is supposed to
stay near zero — that's the design working, not a bug (there's a note about
this in the README if the low first-score surprises you).

Identity is a did:key — an agent's Ed25519 keypair doubles as its INAM ID,
so there's no separate signup or account system.

What INAM deliberately does NOT try to be, because the space already has
better answers: not an agent communication protocol (that's MCP for
agent-to-tool, A2A for agent-to-agent — INAM only cares about what happened
after the fact), and not an identity or authorization system (AgentPass,
AITP, Passport Alliance, and W3C DID/VC already do that; INAM just lets you
reference those links).

There are three independent implementations kept behaviorally identical: a
Node/TypeScript reference server, a Cloudflare Worker deployment (Hono + D1 +
KV), and a Python SDK, sharing one canonical crypto/canonicalization core
where it matters. 92 automated tests across all three, including a
cross-language interop test where a Python-drafted receipt gets finalized and
independently verified by separate TypeScript identities against a live
server. Both SDKs are published as `inamprotocol` (npm and PyPI). The
registry is live at https://api.inamprotocol.org, spec and API reference at
https://docs.inamprotocol.org.

Quickstart, if you want to see a real reputation score move rather than read
about it — about 5-10 minutes, no signup, runs against your own local server:
https://github.com/inamprotocol/inam-protocol/blob/main/QUICKSTART.md

This is a reference implementation, not a hardened production system —
storage is currently a single-process JSON file, the request-signing scheme
is a simplified one inspired by RFC 9421 rather than full compliance, and the
reputation model is a single-pass weighted score rather than a full iterative
solve. All of that is deliberate and documented (README, "Deliberate
simplifications," with the intended upgrade path for each), not hidden.

No one outside this repo has used it yet, which is the actual reason I'm
posting. I'd specifically like feedback on: whether the receipt/signature
design holds up under adversarial thinking I haven't considered, whether the
reputation formula's sybil-resistance choices are sound, and whether the
MCP-tool-wrapper integration shape (examples/mcp-tool-wrapper.ts) is the
right way to plug this into an agent that already exists, or whether that's
the wrong integration point entirely.
```

---

## 2. X / Twitter thread (6 tweets)

```
1/ Built INAM: an open registry where two AI agents that transact with each
other can produce a cryptographically signed, tamper-evident record that the
work happened — and build a reputation from that record instead of a
fakeable star rating.

2/ The primitive is an Execution Receipt. Both agents sign it, and its ID is
a hash of its own content — edit it after the fact and the ID (and both
signatures) stop matching. Identity is just an Ed25519 keypair (did:key) —
no signup.

3/ Reputation isn't "count the receipts." It's weighted by counterparty
trust, discounts repeat trading pairs sub-linearly (so two agents can't just
farm score by trading with each other), and decays over time. A brand-new
agent with 2 transactions correctly stays near zero.

4/ What it's NOT: a messaging protocol (that's MCP agent<>tool, A2A
agent<>agent — INAM only cares what happened afterward) or an identity system
(AgentPass / AITP / DID already do that — INAM just references those links).

5/ Reference impl: Node server + an independent Cloudflare Worker deployment
+ Python SDK, kept behaviorally identical, 92 tests across all three. Live at
api.inamprotocol.org. SDKs published as `inamprotocol` on npm and PyPI.

6/ Zero outside users so far — genuinely want technical feedback on the
receipt design and the reputation formula. 5-10 min quickstart (no signup,
runs locally) that gets you a real score change: [QUICKSTART.md link]. Repo:
github.com/inamprotocol/inam-protocol
```

---

## 3. One-paragraph description (GitHub "About" / directory listing)

Longer version, for a directory listing / Awesome-list PR entry where a full
sentence or two is normal:

```
INAM is an open registry where AI agents build a portable, evidence-based
reputation from cryptographically signed, content-addressed Execution
Receipts — the tamper-evident record of one completed interaction between two
agents — instead of from platform-issued star ratings. It's explicitly not a
messaging protocol (see MCP/A2A) or an identity/authorization system (see
AgentPass/AITP/W3C DID) — just the layer that answers "did this work actually
happen, and what's this agent's track record." Reference implementation
spans a Node/TypeScript server, an independent Cloudflare Worker deployment,
and a parity Python SDK (92 tests across all three); SDKs published as
`inamprotocol` on npm and PyPI, live registry at api.inamprotocol.org.
```

Shorter version, sized for GitHub's own repo "About" field (has a fairly tight
character cap):

```
Open registry for portable AI agent reputation, built from signed,
content-addressed Execution Receipts instead of fakeable ratings. Not a
messaging protocol (MCP/A2A) or identity system (DID/AgentPass) — just
verifiable proof of what happened between two agents. Node + Cloudflare
Worker + Python reference impl, 92 tests, live API.
```

**Note on leverage**: of everything in this file, the About-field description
is the highest-leverage, lowest-effort item — it's a 30-second edit on a repo
setting that's currently blank/generic, and it's what shows up in every GitHub
search result and every list of the repo without the maintainer doing anything
else. Worth doing regardless of whether/when the Show HN post or thread go out.
