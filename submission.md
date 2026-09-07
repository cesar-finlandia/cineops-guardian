# CineOps Guardian — Devpost submission text

Partner track: Grafana Labs

- Hosted URL (PUBLIC_URL): https://cineops-guardian-<hash>-uc.a.run.app (from `docs/DEPLOY.md`; live `GET /api/health` returns 200)
- Repository URL: <REPO_URL> (all source/assets/instructions; top-level `LICENSE`, Apache-2.0)
- Demonstration video URL: TBD (DP-DEMO slot; max 180 s per `config/event-facts.json video.max_seconds`)
- Deadline: 2026-09-09 21:00 UTC (`config/event-facts.json deadline_utc`)

## Features & functionality

CineOps Guardian answers a post-production coordinator's incident question —
"which shots are blocked for tomorrow's dailies and why?" — with live Grafana
telemetry. A deterministic 8-step `google-adk` agent plans typed Grafana MCP
operations, queries metrics/logs/traces/dashboards/alerts/incidents through
the Grafana Cloud MCP server, correlates evidence against call sheets and VFX
delivery memos with pure-Python rules, persists snapshots to BigQuery, and —
after explicit human approval in the 3-screen SSE UI — writes a dashboard
annotation plus an incident note back to Grafana. The run streams over SSE;
the result screen shows revised shot priorities, cited findings, hours saved,
and a revised-schedule CSV download.

## Technologies used

`google-adk` (fixed 8-step agent in `engine/agents/agent.py`),
`google-genai` on Vertex AI (`gemini-2.0-flash` in
`engine/providers/gemini.py`), the Grafana Cloud MCP server
(`engine/mcp/grafana_mcp.py`: `mcp_call` / `mcp_write_*`), BigQuery
(`engine/bq/loader.py`), Cloud Run (`Dockerfile` + `scripts/deploy-cloudrun.sh`),
SSE (`GET /events/stream` via the chassis transport). No non-Google AI SDK is
imported or called anywhere (gate: `scripts/hygiene.sh`).

## Other data sources

Call sheets and VFX delivery memos for the demo production PALS
(synthetic corpus under `engine/rag/corpus/`, every record watermarked
`synthetic:true` with first line `SYNTHETIC DEMO DATA — NOT REAL`), plus live
Grafana telemetry seeded by `npm run seed:grafana` (7 days of render-queue
metrics with an injected 90-minute HELIOSFORGE incident window, correlated
failure logs, a provisioned dashboard `cineops-render-queue`, and a p95
latency alert rule).

## Findings & learnings

Operational finding: a sustained queue-latency breach (>120 s over 5
consecutive samples) plus a run of failed render-job logs for one vendor
deterministically marks shots blocked and reprioritizes them, saving measured
coordinator triage hours. MCP lesson: the hosted Streamable-HTTP endpoint
needs headless OAuth, so the transport resolves `auto` with a 20 s initialize
timeout and falls back to the stdio `mcp-grafana` binary with the service-account
token; reads always go through MCP (no HTTP fallback), while annotation writes
use the disclosed REST fallback only when no annotation tool is discovered.

## Disclosure / Provenance

This project reuses 7 component(s) from the Hackathon Chassis Repository:
resilience, platform, ideation, context, data, cost, provenance. Excluded
modules (never used): media, dev-tooling, assembly-advisory, pgm, profile.
The entry's original work was newly created during 2026-07-27 to 2026-09-09
21:00 UTC. Full text: `disclosure.md`.
