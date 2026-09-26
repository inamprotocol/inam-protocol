import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { InamClient, generateKeypair } from "../sdk-js/src/index.js";
import { leafHash, verifyConsistency, verifyInclusion } from "../sdk-js/src/core/merkleLog.js";

/** External monitor for the transparency log (SPEC.md §13, v0.33).
 *
 * The registry's tree head is unsigned by design; tamper-evidence only exists
 * if someone outside the registry keeps old heads and checks each new one
 * against them. This does that: it compares the current STH to the last one
 * recorded in STATE_FILE (JSON lines) and fails loudly if the log shrank, a
 * same-size root changed, or the consistency proof doesn't verify. It also
 * re-hashes every new entry and checks its inclusion, so the published
 * entries are provably the ones in the tree. Read-only; anyone can run it:
 *
 *   STATE_FILE=./sth.jsonl npx tsx scripts/sth-monitor.ts
 *
 * The maintainers' copy runs hourly in .github/workflows/registry-monitors.yml
 * and publishes its history on the `monitor-state` branch. */
const BASE_URL = process.env.INAM_URL ?? "https://api.inamprotocol.org";
const STATE_FILE = process.env.STATE_FILE ?? "sth.jsonl";

type Head = { treeSize: number; rootHash: string; timestamp: string };

// Throws rather than process.exit(): uncaught at top level it still exits 1,
// but lets in-flight sockets close first.
function fail(msg: string): never {
  throw new Error(`TRANSPARENCY LOG CHECK FAILED: ${msg}`);
}

const client = new InamClient(BASE_URL, generateKeypair()); // reads only; the key is never used to sign
const lines = existsSync(STATE_FILE) ? readFileSync(STATE_FILE, "utf8").trim().split("\n").filter(Boolean) : [];
const prev: Head | undefined = lines.length ? JSON.parse(lines[lines.length - 1]) : undefined;
const cur = await client.getTransparencySTH();
console.log(`registry ${BASE_URL}: treeSize ${cur.treeSize}, root ${cur.rootHash}`);

if (prev) {
  console.log(`last recorded: treeSize ${prev.treeSize}, root ${prev.rootHash} (${prev.timestamp})`);
  if (cur.treeSize < prev.treeSize) fail(`log shrank from ${prev.treeSize} to ${cur.treeSize}`);
  if (cur.treeSize === prev.treeSize) {
    if (cur.rootHash !== prev.rootHash) fail(`root changed at unchanged size ${cur.treeSize}`);
    console.log("unchanged, consistent");
  } else {
    const proof = await client.getConsistencyProof(prev.treeSize, cur.treeSize);
    if (!verifyConsistency(prev.treeSize, prev.rootHash, cur.treeSize, cur.rootHash, proof.proof)) {
      fail(`consistency proof ${prev.treeSize} -> ${cur.treeSize} does not verify: history was rewritten`);
    }
    console.log(`consistency ${prev.treeSize} -> ${cur.treeSize} verified`);
  }
}

// Every entry added since the last head: its published data must hash to its
// leaf, and that leaf must be in the tree the registry just committed to.
for (let offset = prev?.treeSize ?? 0; offset < cur.treeSize; ) {
  const { entries } = await client.getTransparencyEntries({ offset, limit: 200 });
  if (entries.length === 0) fail(`entries endpoint returned nothing at offset ${offset} < treeSize ${cur.treeSize}`);
  for (const e of entries) {
    if (e.leafIndex >= cur.treeSize) break;
    if (leafHash(new TextEncoder().encode(e.data)) !== e.leafHash) fail(`entry ${e.leafIndex}: data does not hash to its leafHash`);
    const inc = await client.getInclusionProof(e.leafIndex, cur.treeSize);
    if (!verifyInclusion(e.leafHash, e.leafIndex, cur.treeSize, inc.proof, cur.rootHash)) fail(`entry ${e.leafIndex}: not included in root ${cur.rootHash}`);
  }
  offset += entries.length;
}
if (!prev || cur.treeSize > prev.treeSize) {
  console.log(`${cur.treeSize - (prev?.treeSize ?? 0)} new entr(ies) re-hashed and inclusion-checked`);
  appendFileSync(STATE_FILE, JSON.stringify(cur) + "\n"); // only on change, so the history stays small
}
