#!/usr/bin/env bash
# INAM check: GET <api-base>/v1/check?target=..., print a table, exit 1 when the verdict meets fail-on.
# Inputs via env: INAM_TARGET, INAM_FAIL_ON (fail|caution), INAM_API_BASE. Needs curl and jq.
# Exit: 0 below threshold, 1 verdict meets fail-on, 2 error (bad input, HTTP 4xx/5xx, network, bad JSON). Never passes on error.
set -uo pipefail

err() { echo "::error title=INAM check::$1"; echo "verdict=error" >> "${GITHUB_OUTPUT:-/dev/null}"; exit 2; }

target="${INAM_TARGET:-}"; fail_on="${INAM_FAIL_ON:-fail}"; base="${INAM_API_BASE:-https://api.inamprotocol.org}"
[ -n "$target" ] || err "target is required"
case "$fail_on" in fail|caution) ;; *) err "fail-on must be 'fail' or 'caution', got '$fail_on'" ;; esac

body=$(mktemp); trap 'rm -f "$body"' EXIT
code=$(curl -sS -G -m 60 -o "$body" -w '%{http_code}' -H 'accept: application/json' \
  --data-urlencode "target=$target" "${base%/}/v1/check") || err "network error calling ${base%/}/v1/check"
if [ "$code" -lt 200 ] || [ "$code" -ge 300 ]; then
  err "check API returned HTTP $code: $(jq -r '.error.message // empty' "$body" 2>/dev/null | head -c 300)"
fi
verdict=$(jq -r '.verdict // empty' "$body" 2>/dev/null)
case "$verdict" in pass|caution|fail) ;; *) err "response has no valid verdict" ;; esac

echo "verdict=$verdict" >> "${GITHUB_OUTPUT:-/dev/null}"
{
  echo "### INAM check: $verdict"
  echo "Target: \`$target\`"; echo
  echo "| Status | Check | Detail |"; echo "|---|---|---|"
  jq -r '.checks[]? | "| \(.status) | \(.label | gsub("\\|"; "/")) | \((.detail // "") | gsub("\\|"; "/")) |"' "$body"
} | tee -a "${GITHUB_STEP_SUMMARY:-/dev/null}"

if [ "$verdict" = fail ] || { [ "$verdict" = caution ] && [ "$fail_on" = caution ]; }; then
  echo "::error title=INAM check::verdict '$verdict' meets fail-on '$fail_on'"; exit 1
fi
