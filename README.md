# CineOps Guardian

Post-production incident triage — plain-English questions answered with live Grafana telemetry.

**Partner track: Grafana Labs**

Powered by Gemini 2.5 Flash on Vertex AI (ADC — no API keys) + google-adk.

- Spin-up: [docs/SPINUP.md](docs/SPINUP.md)
- License: [LICENSE](LICENSE)

## Track

Partner track: Grafana Labs

## What it does

CineOps Guardian answers one incident question — which shots are blocked for
tomorrow's dailies and why — with live Grafana telemetry. A deterministic
8-step `google-adk` agent reads Grafana through the MCP server, correlates
evidence against call sheets + VFX delivery memos, persists snapshots to
BigQuery, and writes a dashboard annotation + incident note back only after
explicit human approval. The 3-screen SSE UI runs on Cloud Run.

![architecture](docs/architecture.png)

## How it decides

Deterministic rules (`engine/diagnose/rules.py`, `DIAGNOSTIC_RULES`),
first match wins:

| rule | level |
|---|---|
| R-QUEUE sustained queue-latency breach | blocked |
| R-FAILRUN run of failed render jobs | high |
| R-FANOUT failed job with downstream dependants | blocked |
| R-ALERT firing alert matching vendor | high |
| R-INCIDENT open incident touching production | blocked |
| R-COMMIT commitment due inside window, shot unapproved | medium |
| R-TREND worsening 7-day trend | medium |
| R-OK healthy shot | ok |

Gemini 2.5 Flash on Vertex explains and cites — rules never defer judgment
to the model. Five ADK tools: `tool_load_context`, `tool_plan_queries`,
`tool_query_grafana`, `tool_correlate`, `tool_summarize`.

## Imported-and-called proof

(a) `google-adk` in `engine/agents/agent.py`:

```python
from google.adk.agents import Agent  # engine/agents/agent.py:13
_AGENT = Agent(  # engine/agents/agent.py:201
    model=build_adk_model(),  # engine/agents/agent.py:202 -> "gemini-2.5-flash"
```

(b) `google-genai` in `engine/providers/gemini.py`:

```python
from google.genai import Client  # engine/providers/gemini.py:12
resp = _client().models.generate_content(  # engine/providers/gemini.py:115
```

(c) Grafana MCP in `engine/mcp/grafana_mcp.py`:

```python
def mcp_call(tool: str, args: dict, *, kind: str) -> Any:  # engine/mcp/grafana_mcp.py:424
def mcp_write_annotation(action: RemediationAction) -> Any:  # engine/mcp/grafana_mcp.py:465
```

Live evidence values: model id `gemini-2.5-flash`; `mcp_health()` tool discovery
pending live stack credentials (see `engine/mcp/TOOLS.md`); every MCP call is
appended to `logs/mcp-grafana.jsonl`. No non-Google AI SDK is imported or
called anywhere (gate: `bash scripts/hygiene.sh`).

## Synthetic data

Call sheets + VFX delivery memos for PALS are synthetic fixtures (no
real studio data; every record watermarked `synthetic:true`, every memo first
line `SYNTHETIC DEMO DATA — NOT REAL`). Grafana telemetry is seeded by
`npm run seed:grafana`.

## Run it

Live demo (Cloud Run): **https://cineops-guardian-7h3vdn6jtq-uc.a.run.app**
— open it, click **Load demo production**, then **Diagnose**.

Local run (Windows, Git Bash or PowerShell — run from the repo root):

```bash
cp config/env.example .env   # fill GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION,
                             # GRAFANA_STACK_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN
npm ci && pip install -e .   # use python3.14 -m pip if `pip` points elsewhere
npm run build:ui             # backend serves dist/ at /
uvicorn engine.api.app:app --host 127.0.0.1 --port 8080
# open http://127.0.0.1:8080
```

Needs: Node ≥ 20, Python ≥ 3.11, Google Cloud ADC (`gcloud auth
application-default login` — Vertex AI, no API keys). Without credentials the
app still runs end to end on the synthetic corpus with honest degraded flags.
Full clean-clone procedure: [docs/SPINUP.md](docs/SPINUP.md). Longer
click-by-click walkthrough (Maya's night-before-dailies run):
[design_documents/tutorial/tutorial.md](design_documents/tutorial/tutorial.md).
Human-readable samples of every corpus file:
[design_documents/tutorial/examples/](design_documents/tutorial/examples/).

### Testing the Grafana MCP connection

Health probe (no browser needed):

```bash
curl -s http://127.0.0.1:8080/api/health | python3 -m json.tool
# want: "ok": true, gemini.reachable true,
# grafana_mcp: {"reachable": true, "transport": "stdio", "tool_count": 81, ...}
```

Direct probe of the MCP server (same calls the app makes, needs the `.env`
Grafana values in your shell):

```bash
python3 -c "from engine.mcp.grafana_mcp import mcp_health, mcp_tool_names
print(mcp_health())"                                   # connection + 81 tools
python3 -c "from engine.mcp.grafana_mcp import mcp_call
print(mcp_call('search_dashboards', {'query': 'cineops-render-queue'}, kind='dashboards'))"
```

What counts as proof (track gate): every MCP call is appended to
`logs/mcp-grafana.jsonl` (`tool`, `kind`, `rows`, `ms`, `path`, `ok`); the
discovered tool list is pinned in `engine/mcp/TOOLS.md`; in the UI each
evidence card names its `MCP tool`, and each write receipt shows its tool plus
`path: mcp` with an **Open in Grafana** deep link. Seeding Cloud telemetry:
`npm run seed:grafana` (see script header for Cloud push-target env vars).

## Verified end to end

Three tiers: T0 proves the offline golden fallback boots and completes with no
credentials and no network; T1 (the gate) drives the full Maya flow — seed,
diagnose, 8 streamed steps, approval gate, results, CSV export — against live
Vertex, live BigQuery and a real Grafana MCP server; T2 is the container and
deploy checklist in [docs/DEPLOY.md](docs/DEPLOY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
