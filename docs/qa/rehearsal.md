# Rehearsal record — CineOps Guardian (DP-DEMO §6 step 6)

## Pre-flight (run immediately before every take)

`npm run seed:grafana && curl -s "$PUBLIC_URL/api/health"` must print
`True True True` (gemini reachable, grafana tool_count > 0, bigquery reachable).

Status 2026-09-04: pre-flight BLOCKED — no Grafana Cloud stack credentials and
no deployed PUBLIC_URL in this environment. Local container (WU-DEPLOY-01)
serves `{"ok":false,...}` with all three probes degraded-for-lack-of-creds,
which is the honest offline state.

## Timed rehearsal

- Script total: 180 s (15+15+20+50+20+25+20+15), cap 180 s — verified by
  `config/script-timing.yaml` section sum.
- Cut order if over budget: beat 7 first, then 8, 3, 2, 1 — NEVER beats 4/5/6.
- Fallback rung exercised: rung 3 (golden replay,
  `assets/demodrive/20260904T173852Z/rung3-golden/replay.json`).
- Interactive `faqdef rehearse` cannot run headless (90 s stdin timer + LLM
  judge offline); the binding five Q&As are in `docs/qa/qa-sheet.md`.
- Recording take: not yet performed (needs live stack + PUBLIC_URL + camera).
