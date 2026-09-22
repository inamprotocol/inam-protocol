import { sha256 } from "@noble/hashes/sha256";

/**
 * RFC 6962-style append-only Merkle tree (audit round-2 item 6, SPEC.md
 * v0.30, §13). Pure functions over an ordered array of leaf hashes -- no
 * persisted node structure. Both runtimes store one row per logged event
 * (finalize, dispute opened/resolved, non-performance report) and hand the
 * ordered leaf-hash list to these functions on every read; root/proof
 * computation is O(n) per request over this registry's own event volume.
 * ponytail: recompute-on-demand, not a persisted frontier -- upgrade path
 * if a registry's log ever grows large enough to make that measurably slow.
 *
 * Domain separation per RFC 6962 §2.1: a leaf hash and an internal node
 * hash can never collide, because they're prefixed with different single
 * bytes before hashing -- otherwise a malicious log operator could pass off
 * an internal node as if it were a leaf (or vice versa) to fabricate a
 * fraudulent inclusion/consistency proof.
 */
const LEAF_PREFIX = Uint8Array.of(0x00);
const NODE_PREFIX = Uint8Array.of(0x01);

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function nodeHashBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(NODE_PREFIX, left, right));
}

/** RFC 6962 leaf hash: SHA256(0x00 || entry). `entry` is the exact bytes
 *  being logged (canonical JSON of the event record). */
export function leafHash(entry: Uint8Array): string {
  return bytesToHex(sha256(concatBytes(LEAF_PREFIX, entry)));
}

/** Largest power of two strictly less than n (n > 1). RFC 6962's split
 *  point for dividing a subtree of size n into a left power-of-two half
 *  and a right remainder. */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function subtreeHash(leafHashes: string[], start: number, end: number): Uint8Array {
  const n = end - start;
  if (n === 1) return hexToBytes(leafHashes[start]);
  const k = splitPoint(n);
  return nodeHashBytes(subtreeHash(leafHashes, start, start + k), subtreeHash(leafHashes, start + k, end));
}

/** RFC 6962 MTH(D[0:n]): the root hash over the given leaf hashes. */
export function rootHash(leafHashes: string[]): string {
  if (leafHashes.length === 0) return bytesToHex(sha256(new Uint8Array(0)));
  return bytesToHex(subtreeHash(leafHashes, 0, leafHashes.length));
}

/** RFC 6962 PATH(m, D[0:n]): the audit path proving leafHashes[m] is
 *  included in the tree over leafHashes[0:n], leaf-to-root order. */
export function inclusionProof(leafHashes: string[], m: number, n: number = leafHashes.length): string[] {
  if (n < 1 || n > leafHashes.length) throw new Error("tree size out of range");
  if (m < 0 || m >= n) throw new Error("leaf index out of range");
  return pathRec(leafHashes, m, 0, n);
}

function pathRec(leafHashes: string[], m: number, start: number, end: number): string[] {
  const n = end - start;
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m - start < k) {
    return [...pathRec(leafHashes, m, start, start + k), bytesToHex(subtreeHash(leafHashes, start + k, end))];
  }
  return [...pathRec(leafHashes, m, start + k, end), bytesToHex(subtreeHash(leafHashes, start, start + k))];
}

/** Verifies an inclusion proof against a claimed root, without needing the
 *  full leaf list. Mirrors pathRec's own recursive split so the proof
 *  array is consumed in exactly the order it was produced. */
export function verifyInclusion(leafHashHex: string, index: number, treeSize: number, proof: string[], expectedRootHex: string): boolean {
  if (index < 0 || index >= treeSize || treeSize < 1) return false;
  const result = verifyPathRec(hexToBytes(leafHashHex), index, 0, treeSize, proof, 0);
  if (!result || result.nextIdx !== proof.length) return false;
  return bytesToHex(result.hash) === expectedRootHex;
}

function verifyPathRec(leaf: Uint8Array, m: number, start: number, end: number, proof: string[], idx: number): { hash: Uint8Array; nextIdx: number } | undefined {
  const n = end - start;
  if (n === 1) return { hash: leaf, nextIdx: idx };
  const k = splitPoint(n);
  if (m - start < k) {
    const inner = verifyPathRec(leaf, m, start, start + k, proof, idx);
    if (!inner || inner.nextIdx >= proof.length) return undefined;
    const sibling = hexToBytes(proof[inner.nextIdx]);
    return { hash: nodeHashBytes(inner.hash, sibling), nextIdx: inner.nextIdx + 1 };
  }
  const inner = verifyPathRec(leaf, m, start + k, end, proof, idx);
  if (!inner || inner.nextIdx >= proof.length) return undefined;
  const sibling = hexToBytes(proof[inner.nextIdx]);
  return { hash: nodeHashBytes(sibling, inner.hash), nextIdx: inner.nextIdx + 1 };
}

/** RFC 6962 PROOF(m, D[0:n]): proves the tree at size m is a prefix of the
 *  tree at size n (0 < m < n). m === 0 or m === n need no proof (the empty
 *  tree is trivially a prefix of anything; a tree is trivially consistent
 *  with itself). */
export function consistencyProof(leafHashes: string[], m: number, n: number = leafHashes.length): string[] {
  if (n < 0 || n > leafHashes.length || m < 0 || m > n) throw new Error("range out of bounds");
  if (m === 0 || m === n) return [];
  return subProofRec(leafHashes, m, 0, n, true);
}

function subProofRec(leafHashes: string[], m: number, start: number, end: number, b: boolean): string[] {
  const n = end - start;
  if (m === n) {
    return b ? [] : [bytesToHex(subtreeHash(leafHashes, start, end))];
  }
  const k = splitPoint(n);
  if (m <= k) {
    return [...subProofRec(leafHashes, m, start, start + k, b), bytesToHex(subtreeHash(leafHashes, start + k, end))];
  }
  return [...subProofRec(leafHashes, m - k, start + k, end, false), bytesToHex(subtreeHash(leafHashes, start, start + k))];
}

/**
 * RFC 6962 §2.1.2 consistency-proof verification (iterative form): proves
 * `oldRoot` (tree of size m) and `newRoot` (tree of size n) describe the
 * same append-only history, i.e. the first m leaves of the n-leaf tree are
 * exactly the m-leaf tree's leaves in the same order -- catching any
 * retroactive edit, reorder, or deletion of a past entry between the two
 * observed roots.
 */
export function verifyConsistency(m: number, oldRootHex: string, n: number, newRootHex: string, proof: string[]): boolean {
  if (m < 0 || n < 0 || m > n) return false;
  if (m === n) return proof.length === 0 && oldRootHex === newRootHex;
  if (m === 0) return true; // the empty tree is consistent with any tree
  if (proof.length === 0) return false;

  let fn = m - 1;
  let sn = n - 1;
  while (fn % 2 === 1) {
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  let idx = 0;
  let oldFr: Uint8Array;
  let newFr: Uint8Array;
  if (fn > 0) {
    if (idx >= proof.length) return false;
    oldFr = newFr = hexToBytes(proof[idx++]);
  } else {
    oldFr = newFr = hexToBytes(oldRootHex);
  }

  while (sn > 0) {
    if (idx >= proof.length) return false;
    const p = hexToBytes(proof[idx++]);
    if (fn % 2 === 1 || fn === sn) {
      oldFr = nodeHashBytes(p, oldFr);
      newFr = nodeHashBytes(p, newFr);
      while (fn % 2 === 0 && fn !== 0) {
        fn = Math.floor(fn / 2);
        sn = Math.floor(sn / 2);
      }
    } else {
      newFr = nodeHashBytes(newFr, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }

  return idx === proof.length && bytesToHex(oldFr) === oldRootHex && bytesToHex(newFr) === newRootHex;
}
