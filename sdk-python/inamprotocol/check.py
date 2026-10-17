"""Pre-payment check via the free hosted /v1/check (same output as `npx inamprotocol check`).
Usage: python -m inamprotocol check <url | 0x wallet | did:key> [--json] [--strict]"""

import json
import sys
import urllib.error
import urllib.parse
import urllib.request

API_BASE = "https://api.inamprotocol.org"
_CHAINS = {1: "Ethereum", 8453: "Base", 84532: "Base Sepolia", 137: "Polygon", 43114: "Avalanche", 11155111: "Sepolia"}
_MARK = {"pass": "[ ok ]", "warn": "[warn]", "fail": "[FAIL]", "info": "[info]"}
_VERDICT = {
    "pass": "PASS     nothing failed and nothing needs a second look",
    "caution": "CAUTION  nothing failed, but some signals are missing; read the [warn] lines before paying",
    "fail": "FAIL     a key check failed; do not pay this endpoint as it stands",
}
_USAGE = "Usage: python -m inamprotocol check <target> [--json] [--strict] [--api-base URL]\n  <target>  an x402 resource URL, an EVM wallet (0x...), or an INAM did:key"


def check(target, api_base=API_BASE, timeout=30):
    """Return the /v1/check report (dict). Raises RuntimeError on an HTTP or network error."""
    url = f"{api_base.rstrip('/')}/v1/check?" + urllib.parse.urlencode({"target": target})
    req = urllib.request.Request(url, headers={"user-agent": "inamprotocol-python-sdk", "accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:200]}") from None
    except (urllib.error.URLError, ValueError) as e:
        raise RuntimeError(str(e)) from None


def _short(a):
    return f"{a[:8]}…{a[-4:]}" if len(a) > 14 else a


def format_report(r):
    out = [f"inam check {r['target']}", "", f"  verdict  {_VERDICT[r['verdict']]}"]
    p = r.get("payment") or {}
    if p.get("accepts"):
        out += ["", "  payment requirements"]
        if p.get("resource"):
            out.append(f"    resource  {p['resource']}")
        if p.get("description"):
            out.append(f"    about     {str(p['description'])[:100]}")
        for a in p["accepts"]:
            price = a.get("price") or f"{a.get('amount', '?')} of {_short(a['asset']) if a.get('asset') else '?'}"
            cid = a.get("chainId")
            net = f"{_CHAINS.get(cid, f'chain {cid}')} ({a.get('network')})" if cid else a.get("network")
            out.append(f"    payTo     {a.get('payTo')}  {price} on {net}")
        if p.get("inamDid"):
            out.append(f"    inam      {p['inamDid']}")
    out += ["", "  checks"]
    for c in r.get("checks", []):
        out.append(f"    {_MARK[c['status']]} {c['label']}")
        if c.get("detail") and c["status"] != "pass":
            out.append(f"           {c['detail']}")
    return "\n".join(out)


def _pop_flag(args, name):
    if name in args:
        args.remove(name)
        return True
    return False


def main(argv):
    args = list(argv)
    as_json, strict = _pop_flag(args, "--json"), _pop_flag(args, "--strict")
    base = API_BASE
    if "--api-base" in args:
        i = args.index("--api-base")
        base = args[i + 1] if i + 1 < len(args) else API_BASE
        del args[i:i + 2]
    helped = _pop_flag(args, "--help") or _pop_flag(args, "-h")
    if helped or len(args) < 2 or args[0] != "check":
        print(_USAGE, file=sys.stderr)
        return 2 if argv else 0
    try:
        r = check(args[1], base)
    except RuntimeError as e:
        print(f"inam check: {e}", file=sys.stderr)
        return 2
    print(json.dumps(r, indent=2) if as_json else format_report(r))
    return 1 if r["verdict"] == "fail" or (strict and r["verdict"] == "caution") else 0
