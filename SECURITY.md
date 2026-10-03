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

## Release pipeline

Packages are published from GitHub Actions with no long-lived tokens:
`inamprotocol` on npm carries SLSA provenance (`npm publish --provenance`),
and `inamprotocol` on PyPI uses Trusted Publishing (OIDC) with
attestations. Check provenance with `npm audit signatures` or on each
package page.

## Threat model

[`THREAT-MODEL.md`](./THREAT-MODEL.md) lists the attacks the protocol
defends against, where each defence is specified, and the known limits.
A report that one of those defences does not hold is in scope; a
limit already listed there is not a new vulnerability, though ideas
for closing one are welcome as issues.

## Scope

In scope: the reference server (`src/`), Cloudflare Worker implementation
(`worker/`), the TypeScript and Python SDKs (`sdk-js/`, `sdk-python/`),
and the deployed instances at `api.inamprotocol.org`,
`docs.inamprotocol.org`, and `inamprotocol.org`.

Out of scope: third-party services, agents, or deployments built on top
of the protocol that aren't operated by this project.
