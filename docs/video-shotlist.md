# Video shot list — CineOps Guardian trailer (DP-DEMO §5)

| # | t_start | t_end | on-screen action | narration line | proof established |
|---|---|---|---|---|---|
| 1 | 0:00 | 0:15 | Maya named on the Ingest screen; the NEON HOLLOW Grafana dashboard failing render queue (incident window from CORPUS.json); dailies deadline chyron. | Meet Maya, post-production coordinator on NEON HOLLOW. Tomorrow's dailies are blocked — the render queue is failing. | pain + incident_window reproducibility |
| 2 | 0:15 | 0:30 | Browser address bar: PUBLIC_URL from docs/DEPLOY.md typed in, live Cloud Run app loading (no mock). | This is CineOps Guardian, live on Cloud Run — not slides, the real product. | CMP-05 live deploy |
| 3 | 0:30 | 0:50 | Ingest screen: plain-English question typed — "Which shots are blocked for tomorrow's dailies and why?"; Diagnose clicked. | Maya asks in plain English which shots are blocked for dailies, and hits Diagnose. | ask |
| 4 | 0:50 | 1:40 | Run screen: the 8 agent steps streaming; evidence cards legible showing live Grafana MCP tool names and row counts; logs/mcp-grafana.jsonl tail inset. | The agent queries the Grafana Cloud MCP server live — every evidence card names the MCP tool and row count. | track gate CMP-03; NEVER CUT |
| 5 | 1:40 | 2:00 | GET /api/health JSON (Gemini reachable on Vertex, live MCP tool list, BigQuery reachable, cost) plus Cloud Run logs tail in terminal. | Health proves it: Gemini reachable on Vertex, the live MCP tool list, BigQuery reachable — with a Cloud Run logs tail. | CMP-02, CMP-05 |
| 6 | 2:00 | 2:25 | Approve button clicked; the write executes; before/after Grafana dashboard with the new annotation and the incident note. | VARIANT-A (mcp write path): Maya approves — the annotation is written through MCP. / VARIANT-B (rest-fallback): Maya approves — the annotation is written back to Grafana. | state change; NEVER CUT |
| 7 | 2:25 | 2:45 | Revised shot priority, findings with citations, the hours-saved figure on screen. | Blocked shots reprioritised with cited findings — hours of coordinator triage saved. | outcome; CUT FIRST if over budget |
| 8 | 2:45 | 3:00 | Closing card: one-line non-obvious insight + Grafana Labs track statement. | Deterministic rules decide; the model explains — built for the Grafana Labs track. | close |
