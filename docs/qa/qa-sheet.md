# Q&A sheet — CineOps Guardian (DP-DEMO §6 step 3)

> `faqdef generate` degraded to the offline fallback checklist (no LLM key;
> no non-Google model call made). The five hardest Q&As below are the binding answers.

## Q1 — Is the Grafana use real or a README mention?

Real — the run screen shows live Grafana MCP tool names and row counts,
GET /api/health lists the live tool list, and logs/mcp-grafana.jsonl records
every call.

## Q2 — What happens if the MCP server is down?

The run degrades per rung: cached evidence disclosed on screen, then local
replay, then demodrive screenshots — never a silent mock.

## Q3 — Is the data real?

PALS telemetry is seeded into the Grafana stack and the incident window
is fixed in CORPUS.json; pre-flight re-seeds via npm run seed:grafana.

## Q4 — What does the model decide versus the rules?

DIAGNOSTIC_RULES decide deterministically; Gemini 2.0 Flash on Vertex explains
and cites — rules never defer judgment to the model.

## Q5 — What did you build during the contest period versus reuse?

The agent, UI, MCP wiring, corpus and demo are new; the reusable chassis is
pre-existing infrastructure disclosed in disclosure.md.
