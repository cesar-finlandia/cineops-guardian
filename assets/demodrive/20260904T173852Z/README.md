# Demodrive capture — 20260904T173852Z

Fallback rungs recorded while the live stack is unreachable (creds absent);
rungs 4–5 and live screenshots require `PUBLIC_URL` + browser + stack creds.

- `rung3-golden/replay.json`: `RES_FORCED_DEGRADED=1` deterministic replay —
  sidecar memo extraction (confidence 0.5) + pure-Python correlation over the
  240-shot corpus (130 ok-findings, byte-identical across runs).
- BLOCKER: `demodrive capture` CLI is broken in this chassis
  (`src/ideation/demodrive/feeder.ts` imports missing
  `../../dev/mock/runner.js` — excluded `dev-tooling` module); screenshot
  capture must run on the operator machine with a browser before recording day.
- BLOCKER: live `PUBLIC_URL` not yet deployed (needs GCP PROJECT_ID/REGION);
  rung 5 (`demodrive capture --url "$PUBLIC_URL"`) runs pre-recording.
