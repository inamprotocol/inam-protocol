# INAM check (GitHub Action)

Fails a workflow step when an x402 endpoint, wallet or agent ID looks unsafe to pay. It calls the free hosted `GET /v1/check`, is read-only and needs no secrets.

```yaml
- id: inam
  uses: inamprotocol/inam-protocol/actions/check@v1
  with:
    target: https://x402.coinstats.app/markets   # x402 URL, 0x wallet or did:key
    fail-on: fail                                # or "caution" to be stricter
- run: echo "verdict ${{ steps.inam.outputs.verdict }}"
```

Pin `@v1`: it is a moving major tag, so you get fixes without editing your workflow, and breaking changes would ship as `@v2`. Use a full commit SHA instead if you want it frozen. `@main` is the development branch and can change at any time.

| Input | Default | Meaning |
|---|---|---|
| `target` | required | x402 URL, `0x` wallet or `did:key` |
| `fail-on` | `fail` | `fail` stops the step on a fail verdict; `caution` also stops on caution |
| `api-base` | `https://api.inamprotocol.org` | point at a self-hosted registry |

Output `verdict` is `pass`, `caution`, `fail`, or `error` (API unreachable or 4xx/5xx; an error never passes). The job summary lists every check. Exit code: 1 when the verdict meets `fail-on`, 2 on error.

Test: `node actions/check/test.mjs`.

## What it does and does not do

It reads public signals (the 402's payment terms, ERC-8004 identity for the payTo, any INAM wallet link and receipts, domain age) and reports `pass`, `caution` or `fail`. A `pass` is not a guarantee the seller will deliver, and the registry is operator-run with no receipts between independent parties yet, so `caution` is the common result today. It moves no money and needs no token or secrets.

## Requirements

A runner with `bash`, `curl` and `jq` (all preinstalled on GitHub-hosted Linux and macOS runners). The composite action does not work on Windows runners without Git Bash.

## Examples

- [`example-workflow.yml`](./example-workflow.yml): a weekly scheduled check you can copy.
- [`.github/workflows/action-check.yml`](../../.github/workflows/action-check.yml): this repo runs the action from its own checkout (`uses: ./actions/check`) against the live API.
- Offline test with a mock server: `node actions/check/test.mjs`.

Publishing to GitHub Marketplace: see [`LISTING.md`](./LISTING.md).
