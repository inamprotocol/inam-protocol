# Trusted Publishing setup — one-time account-side steps

This is a runbook, not a design doc. It closes the two gaps
[`SECURITY.md`](../SECURITY.md) flags under "Known, deliberate gaps in the
release/publish pipeline": PyPI publishing not using Trusted Publishing
(OIDC), and npm publishing not using `--provenance`. The GitHub Actions
side is already done —
[`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml)
and
[`.github/workflows/publish-pypi.yml`](../.github/workflows/publish-pypi.yml)
are written to use OIDC and need no `NPM_TOKEN` or PyPI API token secret.

What's left is two account-side toggles that only the account owner can
set — one on npmjs.com, one on pypi.org. Neither can be done from this
repo or by an agent; both require logging in as the account that owns the
`inamprotocol` package/project. This doc gives the exact fields to enter
so you don't have to figure out the UI from scratch.

Do this once per package. After it's done, cutting a release (or running
either workflow manually) publishes with no manually-copied token
involved — closing exactly the gap SECURITY.md describes.

**Values used below, so they're not repeated in every step:**

| | npm | PyPI |
|---|---|---|
| Package/project name | `inamprotocol` | `inamprotocol` |
| Repository owner | `inamprotocol` | `inamprotocol` |
| Repository name | `inam-protocol` | `inam-protocol` |
| Workflow filename | `publish-npm.yml` | `publish-pypi.yml` |
| Environment name | *(none — leave blank)* | *(none — leave blank)* |

The workflows don't gate publishing behind a GitHub Actions
[environment](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments-for-deployment)
(e.g. requiring a manual approval click before a publish runs) — for a
single-maintainer project, `workflow_dispatch` already gives you manual
control over when a publish happens, so an environment would be a second
gate on top of a gate. Both registries' setup screens ask for an
environment name as an *optional* field — leave it blank on both. If you
later add a `release` environment to either workflow's `publish` job for
extra protection (e.g. once there are other contributors), come back and
fill this field in on both sides to match, or publishing will fail with
an identity mismatch.

---

## 1. npm — configure Trusted Publisher for `inamprotocol`

Prerequisite: you must be logged into [npmjs.com](https://www.npmjs.com/)
as an owner/maintainer of the `inamprotocol` package with 2FA enabled on
your account (npm requires this for publish-related settings changes).

1. Go to the package page: <https://www.npmjs.com/package/inamprotocol>.
2. Click **Settings** (in the package's own navigation, not your account
   settings).
3. Find the **Trusted Publisher** section (npm's docs also call this
   "Publishing access" → GitHub Actions OIDC).
4. Fill in the GitHub Actions form exactly as follows:
   - **Organization or user:** `inamprotocol`
   - **Repository:** `inam-protocol`
   - **Workflow filename:** `publish-npm.yml`
     (enter only the filename — not `.github/workflows/publish-npm.yml`)
   - **Environment name:** leave blank
   - **Allowed actions:** select `npm publish` (you don't need
     `npm stage publish`)
5. Save. npm does **not** validate these fields against the actual repo
   when you save them — a typo in the repo name or workflow filename
   won't error here, it will only surface as a failed publish later. Before
   saving, re-check the four values against the table above and against
   [`.github/workflows/publish-npm.yml`](../.github/workflows/publish-npm.yml)'s
   `name:` line (the workflow's filename, not its `name:` field, is what
   matters).
6. Nothing else to do — no `NPM_TOKEN` secret to add or remove in GitHub
   (there shouldn't be one already; if `NPM_TOKEN` currently exists as a
   repo/org secret from the old `twine`-equivalent npm flow, you can
   delete it after confirming a trusted-publish run succeeds, under
   **Settings → Secrets and variables → Actions** in the GitHub repo).

Reference: npm's own Trusted Publishers documentation is at
<https://docs.npmjs.com/trusted-publishers>. If the UI has moved since
this doc was written, that page is the source of truth — look for
"Trusted Publisher" or "GitHub Actions OIDC" under the package's
Settings.

Note on npm CLI version: OIDC trusted publishing requires npm CLI
`>=11.5.1`. `publish-npm.yml` already handles this (`npm install -g
npm@latest` before publishing) — nothing for you to do here, just don't
remove that step if you ever edit the workflow.

## 2. PyPI — configure Trusted Publisher for `inamprotocol`

Prerequisite: you must be logged into [pypi.org](https://pypi.org/) as an
owner/maintainer of the `inamprotocol` project, with 2FA enabled (PyPI
requires 2FA for all accounts that can manage a project).

1. Go to <https://pypi.org/manage/projects/> ("Your projects").
2. Click **Manage** next to `inamprotocol`.
3. Click **Publishing** in the project's left sidebar (this is the
   "Trusted Publishers" management page).
4. Under "Add a new publisher", choose **GitHub** and fill in:
   - **Owner:** `inamprotocol`
   - **Repository name:** `inam-protocol`
   - **Workflow name:** `publish-pypi.yml`
     (this is the filename under `.github/workflows/`, not the
     workflow's `name:` field)
   - **Environment name:** leave blank
5. Click **Add**. The new publisher appears at the top of the Publishing
   page immediately — PyPI, like npm, doesn't dry-run it against the
   actual repo, so double-check the four values against the table above
   before adding.
6. Nothing else to do — no API token secret to add or remove in GitHub.
   If a PyPI API token currently exists as a repo/org secret (left over
   from the `twine upload` flow this replaces), you can revoke it on
   PyPI (**Account settings → API tokens**) and delete the corresponding
   GitHub secret after confirming a trusted-publish run succeeds.

Reference: PyPI's own Trusted Publishers documentation is at
<https://docs.pypi.org/trusted-publishers/adding-a-publisher/>. If the UI
has moved since this doc was written, that page is the source of truth.

Note: this is the *existing-project* flow (`inamprotocol` is already
published on PyPI, per SECURITY.md's `inamprotocol@0.4.0` reference) —
you're adding a trusted publisher to a project that already exists, not
creating a "pending publisher" for a project that doesn't exist yet. Both
land on the same Publishing page either way.

---

## After setup: what changes

- Cutting a GitHub Release whose tag matches
  `sdk-js/package.json`'s `version` (e.g. tag `0.3.0` or `v0.3.0` for
  version `0.3.0`) automatically publishes to npm with provenance; same
  for a tag matching `sdk-python/pyproject.toml`'s `version` and PyPI.
- If a release's tag doesn't match either package's current version (the
  common case, since this repo cuts one release for the whole repo), the
  corresponding workflow logs a `::notice::` explaining the skip instead
  of publishing — check the Actions run's summary if you expected a
  publish and didn't get one.
- To publish either SDK without waiting for a matching tag, run the
  workflow manually: **Actions → Publish npm package (sdk-js)** or
  **Actions → Publish PyPI package (sdk-python) → Run workflow**.
- No token ever needs to be copied from npmjs.com/pypi.org into a GitHub
  secret again for routine releases. If either workflow's publish step
  fails with an authentication/OIDC error after this setup, the most
  likely cause is a mismatch between the values entered above and the
  actual repo owner/name/workflow filename — re-check the table at the
  top of this doc against both registries' settings before assuming the
  workflow itself is broken.
