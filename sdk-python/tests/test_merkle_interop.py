"""Cross-language correctness for the transparency log's Merkle verification
(audit round-2 item 6). These vectors were generated once by the TypeScript
reference implementation (sdk-js/src/core/merkleLog.ts, via
scripts/gen-merkle-vectors.ts) over a fixed 7-leaf tree. If the Python port
(merkle_log.py) ever diverges from the TypeScript side's proof math, this
test fails -- that divergence is exactly what would make a proof the
registry serves fail (or wrongly pass) verification in an agent using the
Python SDK.
"""

from inamprotocol.merkle_log import verify_consistency, verify_inclusion

# --- Ground truth from `npx tsx scripts/gen-merkle-vectors.ts` ---
TREE_SIZE = 7
ROOT = "08b8af48f1ea6939e6efe801f4ef633b86fd7524af09e31215e0f176b289883e"
LEAF_2 = "f931962f0917c346d447293c07b687ae1609f7003f8a44a06a75c4145b1e1929"
INCLUSION_PROOF_2 = [
    "5c7117fb9edb0cec387257891105da6a6616722af247083e2d6eda671529cdc5",
    "fb33dff7b9f27b94d57431d3c72e3268e5dda9c4de3d2b0d34ab34146d6e6806",
    "881355d7ece1d47edd782a92b5ff895de8e5805b53e7cd94239f513f9ba1744b",
]

OLD_SIZE = 4
OLD_ROOT = "e872bf22aae12fbbdc419c9a6b42ee30943539d08c5de1297abc4f847d3c1644"
CONSISTENCY_PROOF = ["881355d7ece1d47edd782a92b5ff895de8e5805b53e7cd94239f513f9ba1744b"]


def test_python_verifies_a_typescript_produced_inclusion_proof():
    assert verify_inclusion(LEAF_2, 2, TREE_SIZE, INCLUSION_PROOF_2, ROOT) is True


def test_python_rejects_the_same_proof_against_a_tampered_root():
    assert verify_inclusion(LEAF_2, 2, TREE_SIZE, INCLUSION_PROOF_2, "0" * 64) is False


def test_python_rejects_the_same_proof_at_the_wrong_leaf_index():
    assert verify_inclusion(LEAF_2, 3, TREE_SIZE, INCLUSION_PROOF_2, ROOT) is False


def test_python_verifies_a_typescript_produced_consistency_proof():
    assert verify_consistency(OLD_SIZE, OLD_ROOT, TREE_SIZE, ROOT, CONSISTENCY_PROOF) is True


def test_python_rejects_a_consistency_proof_against_a_tampered_new_root():
    assert verify_consistency(OLD_SIZE, OLD_ROOT, TREE_SIZE, "1" * 64, CONSISTENCY_PROOF) is False


def test_python_rejects_a_consistency_proof_against_a_tampered_old_root():
    assert verify_consistency(OLD_SIZE, "1" * 64, TREE_SIZE, ROOT, CONSISTENCY_PROOF) is False
