# Governance

This document says who decides what in INAM Protocol, and what the people who run the public registry promise not to do. It describes the project as it is today: pre-1.0, with one maintainer.

## Roles

- **Maintainer** — merges changes to the specification and code, publishes the packages, and runs the public deployments. Currently [@hheskihoran](https://github.com/hheskihoran).
- **Registry operator** — the identity a registry is configured with to grant and revoke verifier status (SPEC §12.6). For `api.inamprotocol.org` this is the maintainer. Anyone can run a registry with their own operator under another name ([`TRADEMARKS.md`](./TRADEMARKS.md)).
- **Verifier** — an agent identity the operator has granted, whose Verifications count toward reputation (SPEC §12).
- **Contributor** — anyone who opens an issue or a signed-off pull request ([`CONTRIBUTING.md`](./CONTRIBUTING.md)).

## How the specification changes

1. A change to protocol behaviour starts as a GitHub issue that states the problem, the proposed rule, and what it breaks.
2. A change to a wire format, a signature, or how reputation is computed stays open for comment for at least 7 days before it is merged. A security fix may skip this wait and be explained after release.
3. A change is merged only together with a SPEC version bump, a CHANGELOG entry, the same behaviour in both runtimes (Node and Worker) and both SDKs where it applies, and tests. A change to anything that is signed or hashed also needs cross-language test vectors (SPEC §8).
4. Changes are backward compatible by default. A breaking API change ships as `/v2`, with `/v1` kept live for at least 18 months (SPEC §9).

The maintainer decides, and records the reason in the issue or pull request. When a decision rejects a proposal, the reason is written down there too.

## Verifier grants on the public registry

A Verification counts only if the operator granted its verifier, so grants are the main place the operator's judgement enters reputation. On `api.inamprotocol.org`:

**To be granted**, a verifier:

- asks in a public GitHub issue, naming its INAM ID and who runs it;
- states in its registry profile what it checks and what a `verified` from it does and does not mean;
- uses a key that belongs to no other role (not a provider, requester, or operator key).

**A grant is revoked** if the verifier's key may be compromised, if it signs outside the scope its profile states, or if its operator asks. A revocation stops its past Verifications from counting (SPEC §12.4) and is announced in the same issue.

**Current grants:**

| Verifier | INAM ID | Checks |
|---|---|---|
| INAM Integrity Verifier (maintainers) | `did:key:z6MkoERaG7ttjBvSbEsEFx7mdd7BKvntqrESqosxPSHLxe5F` | Output bytes match `outputHash`. Not correctness (SPEC §12.8). |

This table is the list of record. A relying party that does not accept the operator's choices can apply its own verifier list instead (SPEC §5.4).

## Commitments of the public registry's operator

- **Scores are not for sale.** No payment, partnership, or sponsorship changes an agent's score, its search ranking, or a Verification. Paid services, if they come, will be about capacity and support, never about outcomes.
- **No silent history changes.** Receipt events go into the public transparency log, and the maintainers publish an independent monitor's history and Bitcoin timestamps for it (SPEC §13.4). The only edit the operator may make is erasing a stored payload, which leaves every proof valid (SPEC §13.3).
- **The same rules for the maintainers' own agents.** Reference agents are labelled `reference` and are scored exactly like everyone else's (SPEC §2).
- **Security problems are disclosed.** Vulnerabilities are handled as described in [`SECURITY.md`](./SECURITY.md), and known limits are listed in [`THREAT-MODEL.md`](./THREAT-MODEL.md).

## Operator key

The operator's private key is kept outside every deployment and CI system and is used only for grants. If it is lost or may be compromised, the maintainer configures a new operator ID, reviews and revokes the grants made with the old one, re-grants the legitimate verifiers, and announces the change in a GitHub issue.

## Changing this document

Changes to this document follow the same 7-day comment rule as wire-format changes.

## Toward shared governance

One maintainer is a single point of failure, and the project means to grow out of it: adding maintainers from organisations that use INAM, and bringing the specification to an open standards body once it has independent implementations.
