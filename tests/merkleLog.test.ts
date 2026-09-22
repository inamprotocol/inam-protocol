import { describe, expect, it } from "vitest";
import { leafHash, rootHash, inclusionProof, verifyInclusion, consistencyProof, verifyConsistency } from "../sdk-js/src/core/merkleLog.js";

// RFC 6962-style Merkle tree (audit round-2 item 6). No external test
// vectors are targeted -- this registry doesn't need interop with an
// external CT ecosystem -- so correctness is established by exhaustive
// self-consistency: every proof this module generates must verify true
// against its own root, and a single-bit tamper must always verify false.
// The consistency-proof algorithm in particular has tricky bit-level index
// arithmetic (RFC 6962 §2.1.2); this is the "one runnable check" for it.

function leaves(n: number): string[] {
  return Array.from({ length: n }, (_, i) => leafHash(new TextEncoder().encode(`entry-${i}`)));
}

function flipHex(hex: string): string {
  const byte = parseInt(hex.slice(0, 2), 16);
  return (byte ^ 0xff).toString(16).padStart(2, "0") + hex.slice(2);
}

describe("Merkle log: leaf/root hashing", () => {
  it("is deterministic and order-sensitive", () => {
    const a = leaves(5);
    const b = leaves(5);
    expect(rootHash(a)).toBe(rootHash(b));
    const swapped = [a[1], a[0], a[2], a[3], a[4]];
    expect(rootHash(swapped)).not.toBe(rootHash(a));
  });

  it("MTH({}) is the empty-string SHA-256, per RFC 6962", () => {
    expect(rootHash([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("a single-leaf tree's root is just that leaf's hash", () => {
    const [only] = leaves(1);
    expect(rootHash([only])).toBe(only);
  });
});

describe("Merkle log: inclusion proofs", () => {
  it("every leaf in trees of size 1..40 produces a proof that verifies true against the real root", () => {
    for (let n = 1; n <= 40; n++) {
      const l = leaves(n);
      const root = rootHash(l);
      for (let m = 0; m < n; m++) {
        const proof = inclusionProof(l, m, n);
        expect(verifyInclusion(l[m], m, n, proof, root)).toBe(true);
      }
    }
  });

  it("rejects a proof for the wrong leaf hash, a tampered proof entry, or the wrong root", () => {
    const l = leaves(9);
    const root = rootHash(l);
    const proof = inclusionProof(l, 3, 9);
    expect(verifyInclusion(l[3], 3, 9, proof, root)).toBe(true);

    expect(verifyInclusion(l[4], 3, 9, proof, root)).toBe(false); // wrong leaf
    expect(verifyInclusion(l[3], 3, 9, [flipHex(proof[0]), ...proof.slice(1)], root)).toBe(false); // tampered proof
    expect(verifyInclusion(l[3], 3, 9, proof, flipHex(root))).toBe(false); // tampered root
    expect(verifyInclusion(l[3], 3, 9, [...proof, proof[0]], root)).toBe(false); // extra proof entry
  });

  it("rejects an out-of-range leaf index", () => {
    const l = leaves(5);
    expect(() => inclusionProof(l, 5, 5)).toThrow();
    expect(verifyInclusion(l[0], -1, 5, [], rootHash(l))).toBe(false);
  });
});

describe("Merkle log: consistency proofs", () => {
  it("every (m, n) pair for trees of size 1..40 produces a proof that verifies true", () => {
    for (let n = 1; n <= 40; n++) {
      const l = leaves(n);
      const newRoot = rootHash(l);
      for (let m = 0; m <= n; m++) {
        const oldRoot = rootHash(l.slice(0, m));
        const proof = consistencyProof(l, m, n);
        expect(verifyConsistency(m, oldRoot, n, newRoot, proof)).toBe(true);
      }
    }
  });

  it("rejects a tampered proof entry, a wrong old root, or a wrong new root", () => {
    const l = leaves(13);
    const newRoot = rootHash(l);
    const m = 7;
    const oldRoot = rootHash(l.slice(0, m));
    const proof = consistencyProof(l, m, 13);
    expect(proof.length).toBeGreaterThan(0);
    expect(verifyConsistency(m, oldRoot, 13, newRoot, proof)).toBe(true);

    expect(verifyConsistency(m, flipHex(oldRoot), 13, newRoot, proof)).toBe(false);
    expect(verifyConsistency(m, oldRoot, 13, flipHex(newRoot), proof)).toBe(false);
    expect(verifyConsistency(m, oldRoot, 13, newRoot, [flipHex(proof[0]), ...proof.slice(1)])).toBe(false);
  });

  it("catches retroactive tampering: editing a past leaf changes the new root but an old, honestly-observed root no longer reconstructs", () => {
    const l = leaves(10);
    const observedOldRoot = rootHash(l.slice(0, 4)); // a caller fetched the STH when the log had 4 entries
    const honestNewRoot = rootHash(l);
    const honestProof = consistencyProof(l, 4, 10);
    expect(verifyConsistency(4, observedOldRoot, 10, honestNewRoot, honestProof)).toBe(true);

    // The operator now retroactively edits entry #1 (already covered by the
    // caller's observed old root) and recomputes everything downstream.
    const tampered = [...l];
    tampered[1] = leafHash(new TextEncoder().encode("entry-1-tampered"));
    const tamperedNewRoot = rootHash(tampered);
    const tamperedProof = consistencyProof(tampered, 4, 10);
    // The tampered tree's own 4-leaf prefix no longer matches what the
    // caller actually observed and cached -- this is the tamper-evidence
    // property: the operator cannot produce a proof consistent with the
    // honestly-observed old root once history has been rewritten.
    expect(verifyConsistency(4, observedOldRoot, 10, tamperedNewRoot, tamperedProof)).toBe(false);
  });

  it("m=0 (empty old tree) and m=n (same tree) are trivially consistent with an empty proof", () => {
    const l = leaves(6);
    const root = rootHash(l);
    expect(consistencyProof(l, 0, 6)).toEqual([]);
    expect(verifyConsistency(0, rootHash([]), 6, root, [])).toBe(true);
    expect(consistencyProof(l, 6, 6)).toEqual([]);
    expect(verifyConsistency(6, root, 6, root, [])).toBe(true);
  });
});
