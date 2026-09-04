# CineOps Guardian — 3-Minute Trailer script

> Generated per DP-DEMO §5 shot list (15+15+20+50+20+25+20+15 = 180 s).
> `script generate --validate` cannot run here (chassis
> `contracts/script-timing.schema.json` absent); the boundary sum is verified
> by the WU-DEMO-02 command instead. Total ≤ 180 s cap from
> `config/event-facts.json`.

## Beat 1 — pain (0:00–0:15)

On screen: Maya named on the Ingest screen; the NEON HOLLOW Grafana dashboard
failing render queue (incident window from CORPUS.json); dailies deadline
chyron.

Narration: "Meet Maya, post-production coordinator on NEON HOLLOW. Tomorrow's
dailies are blocked — the render queue is failing."

## Beat 2 — live (0:15–0:30)

On screen: browser address bar, PUBLIC_URL from docs/DEPLOY.md typed in, live
Cloud Run app loading (no mock).

Narration: "This is CineOps Guardian, live on Cloud Run — not slides, the
real product."

## Beat 3 — ask (0:30–0:50)

On screen: Ingest screen, plain-English question typed — "Which shots are
blocked for tomorrow's dailies and why?"; Diagnose clicked.

Narration: "Maya asks in plain English which shots are blocked for dailies,
and hits Diagnose."

## Beat 4 — track gate (0:50–1:40, NEVER CUT)

On screen: run screen, the 8 agent steps streaming; evidence cards legible
showing live Grafana MCP tool names and row counts; logs/mcp-grafana.jsonl
tail inset.

Narration: "The agent queries the Grafana Cloud MCP server live — every
evidence card names the MCP tool and row count."

## Beat 5 — health (1:40–2:00, NEVER CUT)

On screen: GET /api/health JSON (Gemini reachable on Vertex, live MCP tool
list, BigQuery reachable, cost) plus Cloud Run logs tail in terminal.

Narration: "Health proves it: Gemini reachable on Vertex, the live MCP tool
list, BigQuery reachable — with a Cloud Run logs tail."

## Beat 6 — write-back (2:00–2:25, NEVER CUT)

On screen: Approve button clicked; the write executes; before/after Grafana
dashboard with the new annotation and the incident note.

Narration (VARIANT-B, rest-fallback): "Maya approves — the annotation is
written back to Grafana."
Narration (VARIANT-A, mcp write path): "Maya approves — the annotation is
written through MCP."

## Beat 7 — outcome (2:25–2:45, CUT FIRST if over budget)

On screen: revised shot priority, findings with citations, the hours-saved
figure on screen.

Narration: "Blocked shots reprioritised with cited findings — hours of
coordinator triage saved."

## Beat 8 — close (2:45–3:00)

On screen: closing card, one-line non-obvious insight + Grafana Labs track
statement.

Narration: "Deterministic rules decide; the model explains — built for the
Grafana Labs track."
