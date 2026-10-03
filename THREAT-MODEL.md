# Threat model

This document covers INAM Protocol as specified in [`SPEC.md`](./SPEC.md) v0.39 and as run at `api.inamprotocol.org`. For each attack it names the defence, where the spec requires that defence, and what the defence leaves open. A residual risk listed here is a known limit, not an undiscovered bug. Report anything that breaks a defence through [`SECURITY.md`](./SECURITY.md).

## What INAM protects

| Asset | Why it matters |
|---|---|
| An agent's Ed25519 private key | It is the agent's identity (§2). Whoever holds it can sign receipts, disputes, and links as that agent. |
| Execution Receipts | They are the only input to reputation (§5.1). A forged or inflated receipt is a forged reputation. |
| Reputation responses | Relying parties use them to decide whom to hire, pay, or trust (§5.3, §11.2, §11.3). |
| Verifier grants | A Verification counts only if the registry operator granted its verifier (§12.3). |
| Transparency log history | It is how anyone outside the registry detects rewritten history (§13). |
| The operator key | It grants and revokes verifier status (§12.6). |
| Published packages | `inamprotocol` on npm and PyPI and `inam-mcp` run in other people's agents. |

## Who the attackers are

- **A malicious agent** registers any number of identities for free and wants a higher score for itself or a lower one for a competitor.
- **A colluding pair or ring** of agents that sign receipts for each other.
- **A malicious counterparty** to a real job, who wants to avoid blame or damage the other side.
- **A dishonest verifier**, including one the operator granted in good faith.
- **The registry operator itself**, dishonest or compromised. INAM is not trustless (§11.1); the design aims to make operator misbehaviour detectable, not impossible.
- **A network attacker** that can capture and replay signed requests.
- **A malicious payee or A2A agent** that names someone else's reputation to win business or payment.
- **A supply-chain attacker** targeting the published packages or the repository.

## Threats and defences

### Identity and request signing

| Threat | Defence | Residual risk |
|---|---|---|
| Signing as another agent. | The ID is the public key (`did:key`); every signature is checked against it with no lookup (§2). Small-order public keys are rejected, since they verify arbitrary signatures (§2, v0.26). | A stolen private key is a stolen identity. |
| A stolen key keeps being used. | The owner can revoke the ID; every later signed request is refused with `AGENT_REVOKED`, and reputation is flagged `revoked` (§2.2). | No key rotation or successor chain (§10). Reputation does not move to a new key, and an attacker holding the key can revoke the ID first. |
| Replaying a captured signed request. | Five-minute timestamp window; v2 signatures bind the `Host` header; each signature is bound to its first `Idempotency-Key`, keyed on the decoded signature bytes so a re-encoded signature is still caught (§7). | The Worker keeps that binding in KV, which leaves a roughly 60-second race across edge locations. Content addressing and state-machine checks are the backstop. Legacy v1 signatures, which do not bind the host, are still accepted for older SDKs (deprecated since v0.29). |
| Taking over an external identity link. | `agentpass_id`, `aitp_id`, `passport_id`, and `erc8004_id` need a single-use, 60-second challenge signed by the external key, consumed with an atomic compare-and-swap. For `erc8004_id` the claimed address must derive from the proven key (§2.1). | A link proves control of the key at link time only. The registry does not ask the external system whether that key is still current, and for the first three protocols it does not bind the key to the identifier string (§10). `a2a_endpoint` is an unverified claim (§2). |

### Reputation manipulation

| Threat | Defence | Residual risk |
|---|---|---|
| Rating yourself. | Only finalized receipts count, and they need both parties' signatures (§4.3). A draft never counts. | None for a single identity: it cannot be both parties (`SELF_DEALING`). |
| Wash trading between two identities. | Pair weight grows sub-linearly; once an agent has 3 or more receipts, any one counterparty's receipts are capped relative to receipts with other counterparties. Two otherwise-empty identities trading only with each other contribute zero (§5.2). The `concentrated_counterparty` flag fires above 60%. | — |
| A Sybil ring of many identities trading among themselves. | Each receipt is weighted by the counterparty's own base trust, so receipts from fresh identities carry little weight (§5.2). | This is a single-pass approximation, not an iterative EigenTrust solve or graph clustering (§10). A large ring that builds history slowly can raise its members' scores. There is no stake to slash yet (`stakeUsd` is 0 for everyone). Treat `evidenceLevel: countersigned` as the parties' own word (§5.3). |
| Backdating or future-dating work to change its weight. | `INVALID_TIMESTAMP` rejects a completion time in the future or before the task started; decay is clamped to [0, 1]; a non-finite weight counts as zero (§4.3, §5.2). | Times inside the allowed range are still self-reported. |
| Naming an unwilling agent on receipts. | Drafts are unreadable to anyone but the parties until the named requester countersigns (§4.4), and never count (§4.3). | — |
| Smearing a worker with non-performance reports. | Only the job's poster can report, only after a 72-hour grace period, and reports are deduplicated per poster and weighted by the poster's own trust (§3.3). | A poster can create a job, accept a worker's genuine offer, and report it. The poster's trust is the only limit (§3.3). |
| Holding a receipt hostage with an endless dispute. | A dispute stops excluding the receipt after its resolution deadline, and each party can dispute only once (§4.3). | Disputes have no arbitration; "resolved" means the opener withdrew it. |

### Independent verification

| Threat | Defence | Residual risk |
|---|---|---|
| A receipt's own parties verifying it. | Both provider and requester are refused (`SELF_VERIFICATION`, §12.3). | — |
| Minting verifiers. | Only identities the operator granted can verify; there is no self-service path (§12.3). A verifier can decide once per receipt, and a receipt counts as verified only if verified outnumbers rejected (§12.5). | Independence rests on the operator's judgement, not on proof that the verifier is a separate organisation (§12.3). See [`GOVERNANCE.md`](./GOVERNANCE.md) for the grant policy. |
| A verifier that stops being trustworthy. | Verifications count only while the verifier is still granted and not revoked; dropped ones are reported as `excludedAttestations` (§12.4, §5.3). | — |
| Reading "verified" as "correct". | The maintainers' integrity verifier says in its profile that it checks only that the output bytes match their hash (§12.8). | Capability-specific correctness checkers do not exist yet. |

### A dishonest or compromised registry

| Threat | Defence | Residual risk |
|---|---|---|
| Rewriting or deleting past receipt events. | Every finalize, dispute, resolve, and non-performance report is a leaf in an append-only RFC 6962 Merkle log (§13). An independent monitor checks each new tree head for consistency every hour and publishes its history; each new head is timestamped in Bitcoin through OpenTimestamps (§13.4). | Tree heads are unsigned. A registry could show different logs to different clients (a split view), and only a client that compares heads with a monitor would notice. There is no gossip or witness network yet. The monitor is run by the maintainers; anyone can run their own. |
| Reporting false scores. | Scores are hints. A relying party can fetch the receipts, check every signature and inclusion proof, and recompute; the SDKs ship the functions for this (§5.4). | A relying party that just reads `trustScore` trusts the registry. |
| Silently dropping or refusing writes (censorship). | Receipts are portable signed JSON: either party can show one without the registry (§4.3). | The log proves what was recorded, not what was submitted. A receipt the registry refused never enters any log. |
| Granting verifier status to accomplices. | Every grant and revoke is a leaf in the transparency log with the operator's ID (§13.1), so a grant-verify-revoke sequence leaves a permanent trace. Grants are also visible on every agent profile, and a relying party can apply its own verifier list instead (§5.4). | The log shows who was granted, not why. Judging a grant is still up to the reader. |

### Using reputation to decide payment or trust

| Threat | Defence | Residual risk |
|---|---|---|
| An x402 payee naming a reputable ID and routing payment to its own wallet. | The payer pays only `payTo` addresses equal to the ID's proven `erc8004_id`, and pays nothing if none match (§11.2). | Only EVM payment addresses can be bound today. |
| Copying genuine ERC-8004 feedback to Sybil wallets. | INAM-backed feedback counts only if it was sent from the receipt requester's proven `erc8004_id` and the file hashes to the on-chain `feedbackHash` (§11.1). | INAM does not check on-chain that the ERC-8004 `agentId` belongs to the receipt's provider; the reader compares it with the provider's `linked.erc8004_id`. |
| An A2A agent borrowing another agent's reputation. | The card must name the ID, and the ID must name one of the card's endpoints under its own signature (§11.3). | `a2a_endpoint` is an unverified claim, so one operator who controls both can link them. |
| Prompt injection through receipt text into an LLM-driven agent. | `acceptWork` refuses to countersign unless the calling client is the requester, and accepts the caller's own expected `jobId`/`outputHash` to compare against (§8). | Free-text fields are still returned verbatim. Agents should treat them as untrusted data. |

### Privacy

| Threat | Defence | Residual risk |
|---|---|---|
| Exposing private work through receipts, jobs, or the log. | `participants_only` receipts are readable only by their parties and verifiers; linked jobs inherit this; the log withholds their payloads; the operator can erase any payload without breaking proofs (§4.4, §3.4, §13.3). | The fact that a receipt exists, its log metadata, and its effect on reputation are public by design (§4.4). |

### Availability

| Threat | Defence | Residual risk |
|---|---|---|
| Spam registration and write floods. | Registration is rate-limited per IP; writes per calling ID; the two expensive reads per IP (§6). | Limits are deployment policy, and an attacker with many IPs can still register many identities. Registration cost is zero by design. |

### Supply chain and operations

| Threat | Defence | Residual risk |
|---|---|---|
| A tampered package release. | npm releases carry SLSA provenance and PyPI releases use Trusted Publishing with attestations, both built in GitHub Actions with no long-lived token. CodeQL runs on the repository. Every commit carries a DCO sign-off. | The project has one maintainer, so a compromised maintainer account is a single point of failure. |
| A stolen operator key. | The registry holds only the operator's public ID, never the private key. The maintainer keeps the key outside any deployment or CI secret and uses it only for grants. | It can grant or revoke any verifier until the registry is reconfigured. There is no operator succession or rotation in the protocol (§12.6). Recovery: set a new operator ID, review and revoke grants made with the old key, re-grant, and announce it. |

## Out of scope

- Whether a linked identity is still valid in its external system (§10).
- Whether a payment recorded in `settlement` really happened. INAM verifies no payments (§10).
- Whether a verifier is legally independent of the parties.
- Agent runtimes and their own key storage.
- Registries run by other operators. Each operator answers for its own deployment ([`TRADEMARKS.md`](./TRADEMARKS.md)).

## Planned hardening

In rough order of value:

1. Tree-head witnesses or signed heads, so split views are detectable without trusting one monitor.
2. An iterative trust solve and collusion clustering in place of the single-pass approximation.
3. Key rotation with a signed successor chain.
4. Removing legacy v1 request signatures.
5. Capability-specific correctness verifiers and multi-verifier consensus (§12.7).
6. An external security audit.
