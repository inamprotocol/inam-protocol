"""Allow / escrow / deny from the registry's appraisal, decided client-side
(SPEC.md §5.4). Mirrors tests/trustDecision.test.ts, including the exact
reason strings, so both SDKs explain a decision the same way."""

from inamprotocol.client import InamApiError
from inamprotocol.trust import check_trust, decide_trust

DID = "did:key:z6MkagentEXAMPLE"


def agent(revoked_at=None):
    return {"id": DID, "linked": {}, "revokedAt": revoked_at}


def rep(**o):
    return {"trustScore": 40, "evidenceLevel": "countersigned", "flags": [], **o}


def test_allows_independently_verified_history_with_a_reason():
    d = decide_trust(agent(), rep(evidenceLevel="independently_verified"))
    assert d["decision"] == "allow"
    assert d["reasons"] == ["evidence independently_verified, trustScore 40"]


def test_escrows_countersigned_only_by_default_allows_it_with_a_lower_bar():
    assert decide_trust(agent(), rep())["reasons"] == ["evidence countersigned is below independently_verified"]
    assert decide_trust(agent(), rep(), allow={"min_evidence": "countersigned"})["decision"] == "allow"


def test_escrows_an_agent_with_no_history():
    d = decide_trust(agent(), rep(evidenceLevel="none", trustScore=0))
    assert (d["decision"], d["reasons"]) == ("escrow", ["evidence none is below independently_verified"])


def test_caps_at_escrow_on_warning_flags_including_suffixed_ones():
    flags = ["in_dispute", "concentrated_counterparty:did:key:z6Mkother"]
    d = decide_trust(agent(), rep(evidenceLevel="independently_verified", flags=flags))
    assert (d["decision"], d["reasons"]) == ("escrow", ["flag in_dispute", "flag concentrated_counterparty:did:key:z6Mkother"])
    assert decide_trust(agent(), rep(evidenceLevel="independently_verified", flags=["in_dispute"]), escrow_flags=[])["decision"] == "allow"


def test_denies_below_the_escrow_bar_and_on_revocation():
    d = decide_trust(agent(), rep(trustScore=5), escrow={"min_trust_score": 10})
    assert (d["decision"], d["reasons"]) == ("deny", ["trustScore 5 is below 10"])
    assert decide_trust(agent("2026-10-01T00:00:00Z"), rep())["decision"] == "deny"


def test_formats_scores_like_javascript():
    d = decide_trust(agent(), rep(evidenceLevel="independently_verified", trustScore=7.6))
    assert d["reasons"] == ["evidence independently_verified, trustScore 7.6"]


class Missing:
    def get_agent(self, did):
        raise InamApiError("GET", "/v1/agents", 404, {})


class Known:
    def get_agent(self, did):
        return agent()

    def get_reputation(self, did):
        return rep()


def test_check_trust_denies_unknown_ids_and_decides_known_ones():
    assert check_trust(DID, Missing()) == {"did": DID, "decision": "deny", "reasons": ["INAM ID not found in the registry"]}
    assert check_trust(DID, Known())["decision"] == "escrow"
