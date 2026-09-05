# Provenance & Disclosure

> Generated from `assembly.manifest.json` — do not hand-edit accuracy; polish wording only if needed. Verbatim reuse by DECKGEN-02 / SUBMIT-02 / FAQDEF-02 (contract 8).

This project reuses **7** component(s) from the Hackathon Chassis Repository (`v0.0.0-` / `LICENSE: MIT`).

## Reused components (7)

- **resilience** — Resilience & Demo-Proofing Layer (`RES-*`) — Generic `withResilience` wrapper + `DegradedResult` + golden cache.
- **platform** — Platform Layer (`DEP/TRN/UI`) — One-command deploy, typed streaming bus, 3 distinct UI themes.
- **ideation** — Ideation & Pitch Tooling (`PIT/IDEA/RETRO`) — PIT deck skeleton, IDEA worksheet, RETRO template + 4 Hour 48–72 auto-populators `ideation/deckgen/script/demodrive/faqdef`.
- **context** — Context & Conversation Buffer (`CTX-*`) — Provider-agnostic message buffer + pluggable token counter.
- **data** — Synthetic Demo-Data Generator (`DATA-*`) — On-demand synthetic data generation with `synthetic:true` marker.
- **cost** — Cost & Usage Guardrail (`COST-*`) — Token/request metering + budget warnings, reuses `CTX-02` counter.
- **provenance** — Provenance & Disclosure (`PROV/SUBMIT`) — Disclosure generator (`prov`) + submission formatter + repo hygiene guard (`submit`).

## How to cite

Cite the chassis repository as prior scaffolding per `XCUT-01` / `LICENSE`. Full disclosure source: `assembly.manifest.json` (`manifest_version 1.0.0`, `chassis_version v0.0.0-unresolved`).

_Generated at 2026-09-04T17:15:37.513Z from manifest hash 36917ef3011634358050476c551f340248b4607eefc9e4db9cfe329dc50e91c1._

## Prior work

The pre-existing reusable chassis (Hackathon Chassis Repository) provides the
included modules: resilience, platform, ideation, context, data, cost,
provenance. Excluded modules (never used by this entry): media, dev-tooling,
assembly-advisory, pgm, profile. The entry's original work — the CineOps
Guardian agent, UI, MCP wiring, corpus and demo — was newly created during
2026-07-27 to 2026-09-09 21:00 UTC.

## AI tools used

Google Cloud AI tools: Gemini 2.5 Flash on Vertex AI via `google-genai`
(`engine/providers/gemini.py`) and the `google-adk` agent framework
(`engine/agents/agent.py`). Coding assistance was used for implementation.
No non-Google AI model, agent framework, or AI API is imported or called
(pointer: `scripts/hygiene.sh`).

Annotation writes use the Grafana HTTP API while all reads go through the MCP server.
