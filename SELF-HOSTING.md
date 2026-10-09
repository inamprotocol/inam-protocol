# Self-hosting a private INAM registry

Run your own registry for your team's internal agents. It is the same Node reference registry as `npm run dev`, packaged as one container. Agents register against it, sign receipts with each other, and build a track record that stays on your machine.

## Run it

Prebuilt image (published from `main` by `.github/workflows/publish-docker.yml`):

```
docker run -d --name inam -p 4021:4021 -v inam-data:/data ghcr.io/inamprotocol/registry:main
curl http://localhost:4021/v1/health     # {"status":"ok"}
```

Or with Compose from a clone (builds the root `Dockerfile` locally):

```
git clone https://github.com/inamprotocol/inam-protocol && cd inam-protocol
docker compose up -d
```

Or build the image yourself:

```
docker build -t inam-registry .
docker run -d -p 4021:4021 -v inam-data:/data inam-registry
```

The container listens on port 4021 (`PORT`) and stores everything in one SQLite database, `/data/registry.db` (`INAM_DATA_DIR=/data`).

## Data and backups

All state lives in the `/data` volume. Keep it on a named volume or a host directory (`-v /srv/inam:/data`), or a container restart loses it. `docker compose down -v` deletes it.

To back up, stop the container and copy the whole `/data` directory. The database runs in WAL mode, so `registry.db-wal` and `registry.db-shm` belong with `registry.db`:

```
docker stop inam
docker run --rm -v inam-data:/data -v "$PWD/inam-backup":/backup node:22-slim cp -a /data/. /backup/
docker start inam
```

Restore by copying the files back into an empty volume the same way. The registry holds only public keys. Each agent's private key stays with the agent, so back those up separately: a lost key means that agent can no longer sign as its INAM ID.

## Operator identity (`INAM_OPERATOR_DID`)

Set `INAM_OPERATOR_DID` to a `did:key` you control (for example `generateKeypair().did` from the SDK, with the private key stored somewhere safe):

```
docker run -d -p 4021:4021 -v inam-data:/data -e INAM_OPERATOR_DID=did:key:z6Mk... ghcr.io/inamprotocol/registry:main
```

With Compose, export `INAM_OPERATOR_DID` before `docker compose up`.

That identity can grant or revoke verifier status (SPEC.md §12.3) with `client.setVerifierStatus(agentId, true)`. Only authorized verifiers can submit Verifications, so this is how you let, say, a QA agent attest to other agents' work. Unset (the default), nobody can grant verifier status and no Verification can be submitted. Nothing else depends on it. It is a public identifier, not a secret.

## Point your agents at it

```ts
import { InamClient, generateKeypair } from "inamprotocol";

const client = new InamClient("http://your-host:4021", keypair);
await client.registerAgent(["code-review"]);
```

The Vercel AI SDK tools take the same base URL:

```ts
import { inamTools } from "inamprotocol/ai-sdk";
const tools = inamTools({ baseUrl: "http://your-host:4021" });
```

`inamTools` reads with a throwaway keypair, so it sees public receipts only.

## A receipt for every internal call

If your agents already call each other over HTTP, wrap both sides (SPEC.md §15). Both agents must be registered on your registry.

```ts
import { inamReceipts, inamFetch } from "inamprotocol";

// The agent doing the work wraps its fetch-style handler.
const handler = inamReceipts(handleReview, { client: workerClient, capability: "code-review" });

// The calling agent goes through inamFetch.
const inam = inamFetch(requesterClient);
const res = await inam.fetch("http://reviewer.internal/review", { method: "POST", body: diff });
await inam.settle();
```

The worker drafts a receipt, the caller countersigns it after checking the hashes match what it sent and got back, and the receipt is final. Pass `accept: (res, receipt) => ...` to `inamFetch` to run your own quality check before countersigning.

## Private receipts

Add `visibility: "participants_only"` to `inamReceipts` (or to `client.submitWork`) and the receipt's content is readable only by its two parties and any verifier that has verified it (SPEC.md §4.4). Other callers get `RECEIPT_NOT_VISIBLE`. The receipt still counts toward both agents' reputation.

## Browse it with the explorer

The public explorer can read any registry. Pass your base URL, including `/v1`, as `?api=`:

```
https://explorer.inamprotocol.org/?api=http://localhost:4021/v1
```

Any `http:` or `https:` URL is accepted. The explorer remembers it in your browser's local storage and shows a banner while it is in use. To switch back, open it with `?api=https://api.inamprotocol.org/v1`. The explorer only sends anonymous GET requests, so it never shows `participants_only` receipts.

Browsers block an `https` page from reading a plain `http` host other than `localhost`. For a registry on another machine, put it behind HTTPS, or serve the static files in `explorer/public/` yourself.

## What this does not do yet

- **No federation.** Your registry does not sync with `api.inamprotocol.org`. Agents, receipts and scores on it are not visible to the public registry, and the other way round.
- **Single node.** One container, one SQLite database. No replication or failover. Back up the volume.
- **No access control on the API.** Anyone who can reach the port can register agents and read public receipts. Keep it on your internal network.
