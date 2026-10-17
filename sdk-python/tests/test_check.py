"""inamprotocol.check / `python -m inamprotocol check` with HTTP mocked."""

import io
import json
import urllib.error
from unittest import mock

import pytest

from inamprotocol import check, format_report
from inamprotocol.check import main

REPORT = {
    "target": "https://x.example/api", "kind": "url", "verdict": "caution",
    "payment": {"resource": "https://x.example/api", "accepts": [{"network": "eip155:8453", "chainId": 8453, "payTo": "0xabc", "price": "0.001 USD Coin"}]},
    "checks": [{"id": "tls", "status": "pass", "label": "HTTPS ok"}, {"id": "inam.link", "status": "warn", "label": "not linked", "detail": "no receipts"}],
}


def fake(body):
    res = mock.MagicMock()
    res.read.return_value = json.dumps(body).encode()
    res.__enter__.return_value = res
    return res


def test_check_calls_hosted_endpoint_with_encoded_target():
    with mock.patch("urllib.request.urlopen", return_value=fake(REPORT)) as u:
        assert check("https://x.example/api?a=1")["verdict"] == "caution"
    assert u.call_args[0][0].full_url == "https://api.inamprotocol.org/v1/check?target=https%3A%2F%2Fx.example%2Fapi%3Fa%3D1"


def test_format_matches_js_layout():
    out = format_report(REPORT)
    assert out.splitlines()[0] == "inam check https://x.example/api"
    assert "payTo     0xabc  0.001 USD Coin on Base (eip155:8453)" in out
    assert "    [ ok ] HTTPS ok" in out and "    [warn] not linked\n           no receipts" in out


@pytest.mark.parametrize("verdict,extra,code", [("pass", [], 0), ("caution", [], 0), ("caution", ["--strict"], 1), ("fail", [], 1)])
def test_exit_codes(verdict, extra, code, capsys):
    with mock.patch("urllib.request.urlopen", return_value=fake({**REPORT, "verdict": verdict})):
        assert main(["check", "0xabc", *extra]) == code
    assert "inam check" in capsys.readouterr().out


def test_json_flag(capsys):
    with mock.patch("urllib.request.urlopen", return_value=fake(REPORT)):
        main(["check", "0xabc", "--json"])
    assert json.loads(capsys.readouterr().out)["verdict"] == "caution"


def test_http_error_exits_2(capsys):
    err = urllib.error.HTTPError("u", 400, "bad", {}, io.BytesIO(b"bad target"))
    with mock.patch("urllib.request.urlopen", side_effect=err):
        assert main(["check", "nope"]) == 2
    assert "HTTP 400" in capsys.readouterr().err


def test_usage():
    assert main(["check"]) == 2
    assert main([]) == 0
