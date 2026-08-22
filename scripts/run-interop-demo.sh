#!/usr/bin/env bash
# Runs the full TypeScript <-> Python cross-language interop demo against a
# fresh local registry: a TS-side requester and a Python-side worker do real
# business through the same running server, proving the two SDKs implement
# one protocol rather than two similar-looking ones.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -f data/*.json .interop-tmp/*.json
mkdir -p .interop-tmp

npx tsx src/index.ts > /tmp/inam-interop-server.log 2>&1 &
sleep 1.5

# On Windows/Git Bash, `npx ... &; $!` captures a wrapper PID, not the actual
# node.exe bound to the port — so find and kill the real listener by port
# instead of trusting $!. Best-effort: harmless if netstat/taskkill are absent.
cleanup() {
  local pid
  pid=$(netstat -ano 2>/dev/null | grep ":4021" | grep LISTENING | awk '{print $NF}' | head -n1)
  [ -n "${pid:-}" ] && taskkill //PID "$pid" //F >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== Phase A (TypeScript): register requester ==="
npx tsx scripts/interop-phase-a-register-requester.ts

PYTHON_BIN="sdk-python/.venv/Scripts/python.exe"
[ -f "$PYTHON_BIN" ] || PYTHON_BIN="sdk-python/.venv/bin/python" # non-Windows venv layout

echo
echo "=== Phase B (Python): register worker, submit signed draft receipts ==="
(cd sdk-python/examples && INAM_HANDOFF="../../.interop-tmp/requester-identity.json" "../../$PYTHON_BIN" interop_worker.py)

echo
echo "=== Phase C (TypeScript): countersign Python's receipts, print reputation ==="
npx tsx scripts/interop-phase-c-countersign.ts

echo
echo "=== Phase D (TypeScript): independent verification of a Python-drafted receipt ==="
npx tsx scripts/interop-phase-d-verify.ts
