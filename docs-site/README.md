# docs.inamprotocol.org

Static site: a landing page (positioning from `SPEC.md` §0), the full protocol specification rendered from `../SPEC.md` with a generated table of contents, and an interactive API reference generated from `../openapi.yaml` via [Redoc](https://github.com/Redocly/redoc) (self-hosted `redoc.standalone.js` — no CDN calls). Deployed as a Cloudflare Worker serving static assets (no server-side logic needed).

## Build & run locally

```
npm install
npm run build   # renders ../SPEC.md and ../openapi.yaml into dist/
npm run dev     # build + wrangler dev, http://localhost:8788
```

`scripts/build.mjs` always reads `SPEC.md` and `openapi.yaml` from the repo root at build time — there's no separate copy to keep in sync. Rerun `npm run build` (or `npm run deploy`, which builds first) any time either of those files changes.

## Deploy

```
npm run deploy
```

Bound to `docs.inamprotocol.org` via `wrangler.jsonc`'s `routes` entry (`custom_domain: true`) on the already-active `inamprotocol.org` Cloudflare zone. Also reachable at the `*.workers.dev` URL wrangler prints, as a fallback.
