# monitor-state

Written only by `.github/workflows/registry-monitors.yml` on `main`. Not code.

- `sth.jsonl` — every transparency-log tree head the monitor has seen on
  `api.inamprotocol.org`, one JSON line each, appended only when the log grows
  and only after proving the new head extends the previous one. Run
  `scripts/sth-monitor.ts` yourself against a copy of this file to check the
  registry independently of us.
- `verifier-state.json` — the integrity verifier's resume point in the log.
