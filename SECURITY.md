# Security Policy

INAM Protocol is an open, Apache-2.0-licensed reference implementation of a
protocol, currently **pre-1.0**. Treat it accordingly: the spec and code are
still evolving, and the deployed reference server (`api.inamprotocol.org`)
is offered as a public reference instance, not a hardened production
service with an SLA.

## Reporting a vulnerability

Please report security vulnerabilities using **GitHub's private
vulnerability reporting**, not a public issue:

1. Go to the repository's **Security** tab.
2. Click **"Report a vulnerability"**.
3. This opens a private GitHub Security Advisory visible only to the
   maintainers, where you can describe the issue and share reproduction
   details.

This is the primary and preferred channel. Do not open a public GitHub
issue for a suspected vulnerability until a fix is available.

## Supported versions

This project is pre-1.0. Only the **latest published version** of each
component (registry server, Worker deployment, `sdk-js`/`sdk-python`
packages) is supported with security fixes. There is no backport policy
for older versions while the protocol is still stabilizing.

## Known, deliberate gaps in the release/publish pipeline

These are known process gaps, not secrets, and are tracked here so they
aren't mistaken for oversights:

- **PyPI publishing is not yet using Trusted Publishing (OIDC).**
  `inamprotocol@0.4.0` on PyPI was published via a maintainer running
  `twine upload` locally with a PyPI API token, not via
  [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/).
  Moving to OIDC-based trusted publishing (no long-lived token, provenance
  tied to the GitHub Actions run that built the release) is a known,
  not-yet-completed hardening step.
- **npm publishing does not yet use `npm publish --provenance`.**
  Releases of the `inamprotocol` npm package (`sdk-js`) are not currently
  published with npm's provenance attestation. Adopting
  `--provenance` (via a trusted npm publish GitHub Action) is a known,
  not-yet-completed hardening step.

Neither gap affects the protocol's cryptographic guarantees (agent
identity, receipt signing, and verification are unaffected) — they affect
the *supply-chain* trust of the published packages themselves, which is
why they're flagged here rather than treated as protocol vulnerabilities.

## Scope

In scope: the reference server (`src/`), Cloudflare Worker implementation
(`worker/`), the TypeScript and Python SDKs (`sdk-js/`, `sdk-python/`),
and the deployed instances at `api.inamprotocol.org`,
`docs.inamprotocol.org`, and `inamprotocol.org`.

Out of scope: third-party services, agents, or deployments built on top
of the protocol that aren't operated by this project.
