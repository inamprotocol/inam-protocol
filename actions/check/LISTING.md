# GitHub Marketplace listing: manual steps for the maintainer

Nothing here has been done yet. The listing is created in the GitHub UI while publishing a release; no one should create releases, tags or listings from scripts.

## Blocker to read first: root action.yml

GitHub Marketplace only lists a repository whose `action.yml` is in the repository root, and a repository can hold one listed action. This action lives in `actions/check/` of the monorepo, so it cannot be listed from here as is. Two options:

1. **Recommended: a small dedicated repo** (for example `inamprotocol/inam-check`) containing `action.yml`, `check.sh`, `README.md` (copy from this directory; `test.mjs` optional). Users would then write `uses: inamprotocol/inam-check@v1`. Keep `actions/check` here working for existing users (`@v1` already exists), and say in its README that the dedicated repo is the listed home.
2. Move `action.yml` to the monorepo root. Not recommended: the root is the registry server, and the root `README.md` and `action.yml` would then be the listing.

The steps below assume option 1, in the new repo.

## Before publishing

- Name must be unique on Marketplace and not match a GitHub user, org or feature name. Check `INAM check` at https://github.com/marketplace?type=actions&query=INAM+check. If taken, change `name:` in `action.yml`.
- `action.yml` already has `name`, `description`, `branding` (icon `shield`, color `blue`; both must come from GitHub's allowed icon and color lists, and they do). The description must be under 125 characters: the current one is 111.
- The repo must be public, and the account that owns it must have accepted the GitHub Marketplace Developer Agreement (the UI prompts for this, 2FA required on the owner account).

## Publish (UI)

1. In the repo, open **Releases** > **Draft a new release** (or, on the repo's `action.yml` page, the banner **Draft a release**).
2. Tick **Publish this Action to the GitHub Marketplace**. If the box is missing, GitHub shows what is wrong (usually a missing root `action.yml` or the agreement not accepted).
3. Primary category: **Security**. Optional second category: **Continuous integration**. (Categories are a fixed GitHub list, chosen here, not in `action.yml`.)
4. Tag: `v1.0.0`, title `v1.0.0`. Release notes: one line, "Pre-payment check of an x402 URL, wallet or did:key via INAM's free hosted /v1/check. Read-only, no secrets."
5. Publish release.
6. Move the major tag so `@v1` works: `git tag -f v1 v1.0.0 && git push -f origin v1` (the existing `v1` tag in the monorepo is separate; the new repo needs its own).

## After

- Open the listing, confirm the README renders, the usage snippet uses the new repo path, and the branding icon shows.
- Run the example workflow from `example-workflow.yml` in a scratch repo, with `uses:` pointing at the new repo, to confirm the published tag works.
- Update `README.md` (root) and the quickstart page (`site/public/quickstart.html`) to the new `uses:` path and add the Marketplace link.
- Later releases: create a new release from the UI, tick the Marketplace box again, and re-point `v1`.
