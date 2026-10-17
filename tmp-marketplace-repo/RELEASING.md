# Releasing v1 (owner steps, GitHub UI)

1. Create the PUBLIC repo `inamprotocol/inam-check` (owner account: 2FA on, Marketplace Developer Agreement accepted). Push the contents of this directory as the repo root (`action.yml` must be at the root).
2. Check the name `INAM check` is free: https://github.com/marketplace?type=actions&query=INAM+check . If taken, change `name:` in action.yml.
3. Releases > Draft a new release > tick "Publish this Action to the GitHub Marketplace". Categories: Security (primary), Continuous integration (optional).
4. Tag `v1.0.0`, title `v1.0.0`, notes: "Pre-payment check of an x402 URL, wallet or did:key via INAM's free hosted /v1/check. Read-only, no secrets." Publish.
5. Move the major tag: `git tag -f v1 v1.0.0 && git push -f origin v1`.
6. Verify: run examples/scheduled.yml in a scratch repo; confirm the README badge link and the icon render on the listing.
7. Then update the root README and site/public/quickstart.html to `uses: inamprotocol/inam-check@v1`.

For later releases repeat steps 3-5 with a new version and re-point `v1`.
