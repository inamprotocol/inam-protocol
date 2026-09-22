"""RFC 6962-style Merkle log verification (audit round-2 item 6, SPEC.md
v0.30, section 13). Verification-only -- proof *generation* stays
server-side (sdk-js/src/core/merkleLog.ts, the source of truth both runtimes
build from); this lets a Python caller independently check an
inclusion/consistency proof returned by InamClient's transparency methods,
without trusting the registry's own arithmetic. Ported 1:1 from
sdk-js/src/core/merkleLog.ts's verifyInclusion/verifyConsistency -- keep the
two in sync.
"""

import hashlib
from typing import List, Optional, Tuple

_LEAF_PREFIX = b"\x00"
_NODE_PREFIX = b"\x01"


def _node_hash(left: bytes, right: bytes) -> bytes:
    return hashlib.sha256(_NODE_PREFIX + left + right).digest()


def verify_inclusion(leaf_hash_hex: str, index: int, tree_size: int, proof: List[str], expected_root_hex: str) -> bool:
    """Verifies an inclusion proof against a claimed root, without needing
    the full leaf list. Mirrors the TS version's recursive split so the
    proof array is consumed in exactly the order it was produced."""
    if index < 0 or index >= tree_size or tree_size < 1:
        return False
    result = _verify_path(bytes.fromhex(leaf_hash_hex), index, 0, tree_size, proof, 0)
    if result is None:
        return False
    digest, next_idx = result
    if next_idx != len(proof):
        return False
    return digest.hex() == expected_root_hex


def _verify_path(leaf: bytes, m: int, start: int, end: int, proof: List[str], idx: int) -> Optional[Tuple[bytes, int]]:
    n = end - start
    if n == 1:
        return leaf, idx
    k = _split_point(n)
    if m - start < k:
        inner = _verify_path(leaf, m, start, start + k, proof, idx)
        if inner is None or inner[1] >= len(proof):
            return None
        inner_hash, next_idx = inner
        sibling = bytes.fromhex(proof[next_idx])
        return _node_hash(inner_hash, sibling), next_idx + 1
    inner = _verify_path(leaf, m, start + k, end, proof, idx)
    if inner is None or inner[1] >= len(proof):
        return None
    inner_hash, next_idx = inner
    sibling = bytes.fromhex(proof[next_idx])
    return _node_hash(sibling, inner_hash), next_idx + 1


def _split_point(n: int) -> int:
    """Largest power of two strictly less than n (n > 1)."""
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def verify_consistency(m: int, old_root_hex: str, n: int, new_root_hex: str, proof: List[str]) -> bool:
    """RFC 6962 section 2.1.2 consistency-proof verification (iterative
    form): proves old_root (tree of size m) and new_root (tree of size n)
    describe the same append-only history -- catching any retroactive edit,
    reorder, or deletion of a past entry between the two observed roots."""
    if m < 0 or n < 0 or m > n:
        return False
    if m == n:
        return len(proof) == 0 and old_root_hex == new_root_hex
    if m == 0:
        return True  # the empty tree is consistent with any tree
    if len(proof) == 0:
        return False

    fn = m - 1
    sn = n - 1
    while fn % 2 == 1:
        fn //= 2
        sn //= 2

    idx = 0
    if fn > 0:
        if idx >= len(proof):
            return False
        old_fr = new_fr = bytes.fromhex(proof[idx])
        idx += 1
    else:
        old_fr = new_fr = bytes.fromhex(old_root_hex)

    while sn > 0:
        if idx >= len(proof):
            return False
        p = bytes.fromhex(proof[idx])
        idx += 1
        if fn % 2 == 1 or fn == sn:
            old_fr = _node_hash(p, old_fr)
            new_fr = _node_hash(p, new_fr)
            while fn % 2 == 0 and fn != 0:
                fn //= 2
                sn //= 2
        else:
            new_fr = _node_hash(new_fr, p)
        fn //= 2
        sn //= 2

    return idx == len(proof) and old_fr.hex() == old_root_hex and new_fr.hex() == new_root_hex
