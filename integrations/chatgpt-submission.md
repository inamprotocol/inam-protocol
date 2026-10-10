# OpenAI plugin (ChatGPT + Codex directory): submission checklist

One submission lists INAM in the plugin directory shared by ChatGPT and Codex.
Source of truth for the rules: https://developers.openai.com/plugins/deploy/submission
and https://developers.openai.com/codex/plugins/build (both read 2026-10-10).
This replaces the old "platform.openai.com → Apps" flow.

## What's in the package (`integrations/openai-plugin/`)

| File | Purpose |
|---|---|
| `plugin.json` | Agent Plugins manifest (`$schema` agent-plugins.org 1.0.0). Listing copy, 5+3 test cases, release notes and `commerce: false` live under `extensions.com.openai`, so they import with the ZIP. |
| `mcp.json` | One remote server `inam` → `https://api.inamprotocol.org/mcp`, `type: streamable-http`. No auth (chosen at **Connect**), no headers, no secrets. |
| `skills/inam-protocol/SKILL.md` | Read-only skill: when to call which tool, how to report scores. Shared with the Cursor plugin and Gemini extension (`npm run check:versions` fails if the copies drift). |
| `assets/icon.png` | 512×512 PNG, used as `logo` and `composerIcon`. |

No `apps`/`.app.json`, no hooks (both block public submission).

Build the ZIP from the committed tree (no tools beyond git; the manifest must be at the ZIP root):

```
git archive --format=zip -o inam-openai-plugin.zip origin/main:integrations/openai-plugin
```

## Listing fields (already in `plugin.json`)

| Field | Value |
|---|---|
| displayName (≤30) | INAM Agent Reputation |
| shortDescription (≤30) | Check AI agents before paying |
| longDescription (≤4000) | see `plugin.json` (1055 chars: what it does, read-only, data sent, limitations) |
| developerName | INAM Protocol (the directory shows the verified identity's name) |
| category | Developer Tools |
| websiteURL | https://inamprotocol.org |
| supportURL | https://github.com/inamprotocol/inam-protocol/issues |
| privacyPolicyURL | https://inamprotocol.org/privacy |
| termsOfServiceURL | https://inamprotocol.org/terms |
| defaultPrompt | 3 starter prompts |
| brandColor / Dark | #7A2E2E / #D98686 (site accent colors) |

## Tool annotations

All six tools on the hosted server declare `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`.
`openWorldHint` is `true` only for `inam_check` (it fetches the target URL, ERC-8004 and domain data);
the other five only read the registry or hash locally, so `false`. Asserted in `worker/tests/api.test.ts`.

## Test cases (in `plugin.json`, all run against prod on 2026-10-10)

Positive (prompt → tools → expected):

1. "What's the INAM reputation of did:key:z6MkjE6iZEFoKkBoxR3QygfWaFUkLUUkj1ry527tUWQB8Gpk?" → `inam_check_reputation` → trustScore > 0 (7.3 today), evidenceLevel `independently_verified`, flags explained.
2. "Find INAM agents that offer verification.output-integrity." → `inam_search_agents` → the "INAM Integrity Verifier" (did:key:z6MkoERaG7ttjBvSbEsEFx7mdd7BKvntqrESqosxPSHLxe5F).
3. "I'm about to pay did:key:z6MkjE6…8Gpk for a code review. Check it first." → `inam_check` → verdict `pass`, per-line checks, `next`; says no payment was made.
4. "Show INAM receipt sha256:b4985e0adbfcadc6198011e99bdcddfe40d11232dec7ed8aef5aeb30007c253e and tell me if it checks out." → `inam_get_receipt`, `inam_verify_receipt` → the code-review receipt with one verification record; integrity verdict `pass`, described as the registry's own check.
5. "Compute the INAM content hash of the text: hello world" → `inam_hash_content` → `sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9`.

Negative (the plugin should not act):

1. "What's the weather in Istanbul tomorrow?" → unrelated; plugin unused.
2. "Send 5 USDC to 0x000000000000000000000000000000000000dEaD." → no payment attempted or claimed; may offer `inam_check` first.
3. "Delete INAM receipt sha256:b4985e0a…253e." → nothing modified; receipts are permanent and the plugin is read-only.

Re-run 1–5 right before submitting (they hit live data). If the reference receipt or agent ever changes, edit `plugin.json` and rebuild the ZIP: imported test cases are read-only in the dashboard.

## Release notes (in `plugin.json` → `publication.release_notes`)

> First release: six read-only tools over the hosted INAM MCP server (agent reputation, agent search, pre-payment check for x402 URLs, wallets and did:keys, receipt lookup, receipt integrity check, content hashing) plus a skill that explains how to report trust scores and evidence levels.

## Domain verification

The MCP URL's host is `api.inamprotocol.org`, so the token is served by the API Worker
(not the static site) at `https://api.inamprotocol.org/.well-known/openai-apps-challenge`:
plain text, only the token, 404 while unset. It reads the Worker secret `OPENAI_APPS_CHALLENGE`.
A secret (not a `vars` entry in `wrangler.jsonc`) so setting it needs no code change and later deploys don't wipe it.

```
cd worker
npx wrangler secret put OPENAI_APPS_CHALLENGE     # paste the token from the portal when prompted
curl https://api.inamprotocol.org/.well-known/openai-apps-challenge   # must print exactly the token
```

The route ships with this PR, so the API must be deployed (Deploy API workflow) before this step.

## Founder-only steps, in order

1. Verify identity (individual is enough): https://platform.openai.com/settings/organization/general → Verify. You must be the organization owner. Keep data residency global.
2. Merge this PR and run the Deploy API workflow, then build the ZIP (command above).
3. https://platform.openai.com/plugins → **Upload new or existing plugin** → choose the verified developer identity → upload `inam-openai-plugin.zip`.
4. **Metadata & Skills**: wait for checks. If there are issues, **Copy issues**, send them to me, re-upload the fixed ZIP.
5. **MCPs** → `inam` → **Connect**. Copy the challenge token, run the `wrangler secret put` command above, check with curl, then finish **Connect** (no auth). Wait for the tool scan; it should find 6 tools.
6. Record the video walkthrough (script below), upload unlisted to YouTube, and paste the URL in **Review information → Review details** (no reviewer credentials needed: no sign-in). Save details.
7. **Submit for review**, complete the policy attestations. Feedback comes by email; to appeal, reply to it.
8. After approval: open the package version → **Publish plugin**.

## Video walkthrough script (~2 minutes, screen recording in ChatGPT with the plugin connected)

1. (0:00) "This is INAM Agent Reputation. It reads a public registry of AI agents' signed work receipts. It's read-only: it never pays, signs or changes anything."
2. (0:15) Run positive case 1. Point at the trust score and the evidence level; say what `independently_verified` means.
3. (0:35) Run case 2. Show the verifier agent in the results.
4. (0:50) Run case 3. Read the verdict and one check line; point out the answer says no payment was made.
5. (1:10) Run case 4. Show the receipt, then the `pass` verdict and that it's the registry's own integrity check.
6. (1:30) Run case 5. Show the hash.
7. (1:40) Run negative case 2 ("Send 5 USDC…"). Show that nothing is paid.
8. (1:55) "Privacy policy and terms are at inamprotocol.org. Thanks."

## Codex users today (no review)

`codex plugin marketplace add inamprotocol/inam-protocol` adds this repo's `.agents/plugins/marketplace.json`,
which points at `integrations/openai-plugin`. Install from the **INAM Protocol** source in the ChatGPT desktop app's Plugins Directory.
