# INAM check

[![INAM check](https://img.shields.io/badge/GitHub%20Marketplace-INAM%20check-blue?logo=github)](https://github.com/marketplace/actions/inam-check)

Fails a workflow step when an x402 endpoint, wallet or agent ID looks unsafe to pay. It calls the free hosted `GET /v1/check` of [INAM Protocol](https://github.com/inamprotocol/inam-protocol), is read-only and needs no secrets.

```yaml
- id: inam
  uses: inamprotocol/inam-check@v1
  with:
    target: https://x402.coinstats.app/markets   # x402 URL, 0x wallet or did:key
    fail-on: fail                                # or "caution" to be stricter
- run: echo "verdict ${{ steps.inam.outputs.verdict }}"
```

`@v1` is a moving major tag (fixes without editing your workflow; breaking changes ship as `@v2`). Pin a full commit SHA to freeze it.

| Input | Default | Meaning |
|---|---|---|
| `target` | required | x402 URL, `0x` wallet or `did:key` |
| `fail-on` | `fail` | `fail` stops the step on a fail verdict; `caution` also stops on caution |
| `api-base` | `https://api.inamprotocol.org` | point at a self-hosted registry |

Output `verdict` is `pass`, `caution`, `fail`, or `error` (API unreachable or 4xx/5xx; an error never passes). The job summary lists every check. Exit code: 1 when the verdict meets `fail-on`, 2 on error.

## What it does and does not do

It reads public signals (the 402's payment terms, ERC-8004 identity for the payTo, any INAM wallet link and receipts, domain age) and reports `pass`, `caution` or `fail`. A `pass` is not a guarantee the seller will deliver, and the registry is operator-run, so `caution` is the common result today. It moves no money and needs no token. Only the target is sent to the API.

## Requirements

A runner with `bash`, `curl` and `jq` (preinstalled on GitHub-hosted Linux and macOS runners). Not supported on Windows runners without Git Bash.

## Examples

See [`examples/`](./examples): a weekly scheduled check and a strict PR gate.

Source of truth and tests live in the [INAM Protocol monorepo](https://github.com/inamprotocol/inam-protocol/tree/main/actions/check). Apache-2.0.
