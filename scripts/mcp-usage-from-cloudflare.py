"""Re-derive the estimated MCP sessions (metric connect_est) from Cloudflare HTTP analytics.

This is how worker/migration-backfill-mcp-usage.sql was produced. Anyone with read access to
the inamprotocol.org zone can re-run it and compare the output with that file:

  CLOUDFLARE_API_TOKEN=... python scripts/mcp-usage-from-cloudflare.py 2026-10-11 2026-11-09 > out.sql

Needs a token with Zone > Analytics > Read. Method: count 202 responses on
api.inamprotocol.org/mcp per UTC day and client family. A 2025-era MCP client sends one
notifications/initialized per session and gets 202, so the count estimates sessions.
Limits: Cloudflare keeps these analytics for about 30 days, and adaptive analytics may be
sampled, so a re-run can differ slightly and older days can no longer be re-derived.
"""
import datetime, json, os, re, sys, urllib.request

TOKEN = os.environ["CLOUDFLARE_API_TOKEN"]
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}


def call(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None, headers=H, method="POST" if body else "GET")
    return json.load(urllib.request.urlopen(req))


def family(ua):  # mirrors clientFamily() in worker/src/mcpUsage.ts
    ua = ua or ""
    if re.match(r"^claude-code/.*\(claude-desktop", ua): return "claude-desktop"
    if re.match(r"^claude-code/.*\(remote", ua): return "claude-remote"
    if ua.startswith("claude-code/"): return "claude-code"
    if ua.startswith("Claude-User"): return "claude-ai"
    return "other"


zone = call("https://api.cloudflare.com/client/v4/zones?name=inamprotocol.org")["result"][0]["id"]
start, end = (datetime.date.fromisoformat(a) for a in sys.argv[1:3])
d = start
while d <= end:
    q = ('query($z:String!){viewer{zones(filter:{zoneTag:$z}){g:httpRequestsAdaptiveGroups(limit:10000,filter:{'
         f'datetime_geq:"{d}T00:00:00Z",datetime_lt:"{d + datetime.timedelta(days=1)}T00:00:00Z",'
         'clientRequestHTTPHost:"api.inamprotocol.org",clientRequestPath:"/mcp",edgeResponseStatus:202})'
         '{count dimensions{userAgent}}}}}')
    r = call("https://api.cloudflare.com/client/v4/graphql", {"query": q, "variables": {"z": zone}})
    if r.get("errors"): sys.exit(r["errors"][0]["message"])
    counts = {}
    for g in r["data"]["viewer"]["zones"][0]["g"]:
        f = family(g["dimensions"]["userAgent"])
        counts[f] = counts.get(f, 0) + g["count"]
    for f, n in sorted(counts.items()):
        print(f"INSERT INTO mcp_usage (day, metric, client, count) VALUES ('{d}', 'connect_est', '{f}', {n}) "
              "ON CONFLICT(day, metric, client) DO UPDATE SET count = excluded.count;")
    d += datetime.timedelta(days=1)
