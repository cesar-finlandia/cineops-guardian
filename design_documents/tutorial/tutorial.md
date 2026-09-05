# CineOps Guardian — full walkthrough

**What you are about to do:** play Maya, a post-production coordinator on the
show *NEON HOLLOW*. It is the evening before dailies. Somewhere in the render
farm, shots are stuck — and Maya has to walk into the 8am dailies meeting able
to say *which* shots are blocked, *why*, and *what she has already done about
it*.

Today that answer takes her an hour of clicking between a Grafana dashboard, a
call-sheet spreadsheet and six VFX delivery memos. In this tutorial it takes
one question typed in plain English, and it ends with an annotation written
back onto the Grafana dashboard the whole team watches, plus a revised shot
order she can hand to the render wrangler.

You will:

1. stand up the pieces (Grafana + telemetry + credentials + the app),
2. run Maya's session in the browser end to end,
3. verify that the agent really wrote back to Grafana,
4. see what happens when the network dies mid-demo.

**How long:** ~30 minutes the first time (most of it downloads), ~4 minutes on
every later run.

**Conventions.** Commands are given for **Git Bash** first. Where PowerShell
differs, a *PowerShell* variant follows immediately. Run everything from the
repository root unless a step says otherwise:

```bash
cd /c/Users/cesar/Documents/CursorAI-projects/hackathon-entries/2026-09-AgenticCinema-2
```

*PowerShell:*

```powershell
cd C:\Users\cesar\Documents\CursorAI-projects\hackathon-entries\2026-09-AgenticCinema-2
```

---

## Part 0 — What the application actually is

Three screens, in order. You will visit all three:

| Screen | What Maya does there | How you know you are on it |
|---|---|---|
| **Ingest** | types the question, picks the incident window, optionally attaches memos, presses **Diagnose** | heading *"Which shots are blocked for tomorrow's dailies — and why?"* |
| **Run** | watches 8 agent steps stream live, reads the Grafana evidence cards, and **approves or rejects** the writes the agent wants to make | a *Progress* list with step names like `query-grafana` |
| **Result** | reads the findings, opens the Grafana annotation, downloads the revised schedule CSV | big counters: *Blocked · High · Writes applied* |

The screens swap in place — this is a single page, there are no browser tabs to
switch between and no menu. The only navigation is the buttons described below.

The important thing to understand before you start: **the agent stops and waits
for you.** It will not touch Grafana until you tick the boxes and press
*Approve*. That pause is the whole point of the product, and it is Part 5.

---

## Part 1 — One-time setup

Skip any step you have already done. If you have run the E2E suite on this
machine before, you can jump to **Part 2**.

### 1.1 Check your tools

```bash
node --version      # need >= 20
python3 --version   # need >= 3.11
docker --version
gcloud --version
```

### 1.2 Install dependencies

```bash
npm ci
pip install -e .
```

`pip install -e .` installs the backend (FastAPI, `google-adk`, `google-genai`,
BigQuery, the MCP client) from `pyproject.toml`.

### 1.3 Give Vertex AI your credentials

Gemini is reached through **Vertex AI with Application Default Credentials**.
There is no API key anywhere in this project — not in a file, not in an env var.

```bash
gcloud auth application-default login
gcloud config set project <your-gcp-project-id>
```

Your Google account needs **Vertex AI User**, **BigQuery Data Editor** and
**BigQuery Job User** on that project. The BigQuery dataset itself is created
for you on first boot — you do not need to make it by hand.

### 1.4 Get the Grafana MCP server binary

The agent does not call Grafana's REST API to *read*; it speaks **MCP** to
Grafana's own MCP server, which runs as a local process. Download it once:

```bash
mkdir -p .e2e-bin
curl -fsSL -o .e2e-bin/mcp-grafana.zip \
  https://github.com/grafana/mcp-grafana/releases/download/v1.3.0/mcp-grafana_Windows_x86_64.zip
cd .e2e-bin && unzip -o mcp-grafana.zip && cd ..
ls .e2e-bin/mcp-grafana.exe
```

On macOS/Linux use `mcp-grafana_Darwin_arm64.tar.gz` or
`mcp-grafana_Linux_x86_64.tar.gz` and `tar -xzf` instead.

`.e2e-bin/` is git-ignored — the binary is a local tool, not part of the repo.

---

## Part 2 — Stand up Maya's Grafana

Maya's world is a Grafana stack showing the render farm. We recreate it locally
with Grafana OSS, Prometheus (the render-queue metrics) and Loki (the failed
render job logs), all in Docker.

### 2.1 Start Grafana

```bash
docker network create cineops-e2e
docker run -d --name cineops-grafana --network cineops-e2e -p 3000:3000 \
  -e GF_SECURITY_ADMIN_USER=admin \
  -e GF_SECURITY_ADMIN_PASSWORD=cineops-e2e-local \
  grafana/grafana-oss:11.5.2
```

`network create` fails harmlessly if the network already exists — carry on.
Already have the container from an earlier session? `docker start
cineops-grafana` is enough. Check with `docker ps`.

Open <http://127.0.0.1:3000> in your browser and log in as `admin` /
`cineops-e2e-local`. Keep this tab open — you will come back to it in Part 6 to
see what the agent wrote.

### 2.2 Load the render-farm telemetry

This converts the synthetic corpus into real Prometheus series and real Loki
log streams, starts both containers on the same Docker network, and registers
them as Grafana datasources:

```bash
python3 design_documents/e2e-testing/telemetry/seed_local_telemetry.py
```

Wait for the last line: `LOCAL-TELEMETRY-READY`. The script is idempotent — run
it again any time you rebuild the stack.

> Without this step the agent still runs, but Grafana has no data to answer
> with: every metrics/logs query degrades honestly and you get zero blocked
> shots. The run "works" and tells you nothing. Do not skip it.

### 2.3 Create a Grafana service-account token

The agent authenticates to Grafana with a service-account token — the same way
a real integration would.

```bash
SA_ID=$(curl -s -u admin:cineops-e2e-local -H "Content-Type: application/json" \
  -X POST -d '{"name":"cineops-agent","role":"Admin","isDisabled":false}' \
  http://127.0.0.1:3000/api/serviceaccounts | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -u admin:cineops-e2e-local -H "Content-Type: application/json" \
  -X POST -d '{"name":"cineops-agent-token"}' \
  "http://127.0.0.1:3000/api/serviceaccounts/$SA_ID/tokens" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['key'])"
```

The last command prints a token starting with `glsa_`. **Copy it — Grafana will
never show it again.** You will paste it in Part 3.

If the first command errors with *"service account already exists"*, you made
one earlier; either reuse that token or use a different `name`.

### 2.4 Provision the dashboard the agent writes onto

The agent's write-back lands as an annotation on a specific dashboard panel, so
that dashboard has to exist:

```bash
python3 - <<'PY'
import json, urllib.request, base64
dash = json.load(open("grafana/dashboard.json", encoding="utf-8"))
auth = base64.b64encode(b"admin:cineops-e2e-local").decode()
body = json.dumps({"dashboard": dash, "overwrite": True}).encode()
req = urllib.request.Request("http://127.0.0.1:3000/api/dashboards/db", data=body,
    method="POST", headers={"Authorization": f"Basic {auth}", "Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=30).read().decode()[:200])
PY
```

You should see a JSON response containing `"uid":"cineops-render-queue"`.
Reload the Grafana tab: a dashboard **"CineOps — NEON HOLLOW render queue"**
now exists.

> `npm run seed:grafana` does this same job **against a hosted Grafana Cloud
> stack** (it also remote-writes the metrics). It does not work against local
> OSS, which has no `/api/prom/api/v1/write` endpoint — hence the two local
> steps above.

---

## Part 3 — Build the UI and start the server

### 3.1 Build the front end

```bash
npm run build:ui
```

This writes `dist/`, which the backend serves at `/`. **The backend serves the
built files, not live source** — so re-run this whenever you change anything
under `src/cineops/`.

### 3.2 Set the environment

Paste your Grafana token from step 2.3 and your GCP project id.

*Git Bash:*

```bash
export GOOGLE_GENAI_USE_VERTEXAI=true
export GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>
export GOOGLE_CLOUD_LOCATION=us-central1
export BQ_DATASET=cineops
export GRAFANA_STACK_URL=http://127.0.0.1:3000
export GRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_xxxxxxxxxxxx
export GRAFANA_TRANSPORT=stdio
export MCP_GRAFANA_BIN="$PWD/.e2e-bin/mcp-grafana.exe"
export PYTHONUTF8=1
```

*PowerShell:*

```powershell
$env:GOOGLE_GENAI_USE_VERTEXAI = "true"
$env:GOOGLE_CLOUD_PROJECT = "<your-gcp-project-id>"
$env:GOOGLE_CLOUD_LOCATION = "us-central1"
$env:BQ_DATASET = "cineops"
$env:GRAFANA_STACK_URL = "http://127.0.0.1:3000"
$env:GRAFANA_SERVICE_ACCOUNT_TOKEN = "glsa_xxxxxxxxxxxx"
$env:GRAFANA_TRANSPORT = "stdio"
$env:MCP_GRAFANA_BIN = "$PWD\.e2e-bin\mcp-grafana.exe"
$env:PYTHONUTF8 = "1"
```

These live in your shell only. Anything you close the terminal on is gone —
that is deliberate, and it is why no secret ever reaches the repository.

`GEMINI_MODEL` is optional; it defaults to `gemini-2.5-flash`.

### 3.3 Start the backend

```bash
python3 -m uvicorn engine.api.app:app --host 127.0.0.1 --port 8080 --timeout-keep-alive 75
```

Wait for `Application startup complete.` Leave this terminal running — it is
your server log, and you will glance at it during the run.

### 3.4 Confirm it is alive before you touch the browser

In a **second** terminal:

```bash
curl -s http://127.0.0.1:8080/api/health
```

You want `"ok":true` and `"reachable":true` on all three of `gemini`,
`grafana_mcp` and `bigquery`. If something is `false`, its `last_error` says
why — see **Troubleshooting** at the end before going further. Diagnosing that
now costs you 30 seconds; diagnosing it after a confusing run costs you ten
minutes.

---

## Part 4 — Maya opens the app

Open <http://127.0.0.1:8080> in your browser.

### What you are looking at

Top-left: the title **CineOps Guardian**. Top-right, a small status pill:

```
● healthy backend   gemini:ok   grafana-mcp:ok   bigquery:ok
```

That pill is Maya's pre-flight check. It refreshes itself every 30 seconds.
Hover it to see the raw health JSON in a tooltip.

- `● checking` — the very first poll has not returned yet, give it a few seconds
- `● healthy` — all three dependencies answered; you are good to go
- `● degraded` — one of them is down. The app **will still run**, it will just
  tell you honestly which parts of its answer are missing. Which is exactly
  what you want it to do at 7am, but not what you want for your first run.

Below it, the ingest form, pre-filled with Maya's actual situation.

### The form, field by field

| Field | Pre-filled with | What it means |
|---|---|---|
| **Production** | `NEON HOLLOW` | which show to triage |
| **Question** | *Which shots are blocked for tomorrow's dailies and why?* | the plain-English question; the agent plans its Grafana queries from this |
| **Window start** | `2026-09-04T14:00:00Z` | start of the incident window to look at |
| **Window end** | `2026-09-04T15:30:00Z` | end of it |
| **Severity floor** | `medium` | ignore anything less severe than this when proposing fixes |
| **Call sheets / memos** | *(empty)* | optional `.pdf` / `.csv` attachments |

**Leave every field exactly as it is for your first run.** Those defaults are
the 90-minute window in which the render farm actually went wrong, and they
match the seeded telemetry. Change the window and you will (correctly) get a
quiet, boring answer.

### Step 1 — Load the demo production

Click **Load demo production**.

- The button greys out and reads *Loading…*
- **This takes 40–60 seconds.** It is loading 240 shots and 8,064 metric rows
  into BigQuery. Nothing is broken; wait for the button to say *Load demo
  production* again.
- Watch the server terminal: you will see `POST /api/seed HTTP/1.1" 200 OK`.

You only need this the first time, or after you have wiped the BigQuery
dataset. On later runs skip straight to *Diagnose* — it ensures the data is
there without reloading it.

If a red line appears saying *"Seed degraded (…) — continuing from local
corpus"*: BigQuery is unreachable. That is a warning, not a wall. The run still
works from the local CSVs. Note it and carry on.

### Step 2 — Ask the question

Click **Diagnose**.

The screen changes. You are now on the **run screen**.

---

## Part 5 — Watching the agent work (and the moment it asks permission)

This is the part worth watching rather than tabbing away from. The whole run
takes roughly **60–120 seconds**.

### The Progress list

A list titled **Progress** fills in top to bottom. Eight steps, always in this
order:

| # | Step | What the agent is doing |
|---|---|---|
| 1 | `load-context` | reads the call sheets and extracts commitments from the six VFX memos (Gemini reads the PDFs directly, in parallel) |
| 2 | `plan-queries` | turns Maya's English question into a concrete Grafana query plan |
| 3 | `query-grafana` | runs those queries **through the Grafana MCP server** |
| 4 | `persist-snapshot` | stores the raw evidence in BigQuery so the run is auditable later |
| 5 | `correlate-evidence` | applies the deterministic rules — this is what decides "blocked" |
| 6 | `propose-remediation` | drafts the fixes: re-prioritise these shots, annotate that dashboard |
| 7 | `write-back` | **pauses and asks you** |
| 8 | `summarize-run` | writes the plain-English summary |

Each row shows a status badge: `started` → `streaming` → `done`. Steps that
have not been reached yet sit below the list as `pending`, so you can always
see how much is left.

### The evidence cards

Under the progress list, cards appear as step 3 runs — one per Grafana call:

```
MCP tool: query_prometheus
kind: metrics
rows: 1
took: 48 ms
```

**Read one of these.** `MCP tool:` is the literal name of the tool the agent
invoked on Grafana's MCP server — `query_prometheus`, `query_loki_logs`,
`search_dashboards`, `list_alert_rules`. This is the proof that the agent is
genuinely talking to Grafana and not making things up. Every one of these calls
is also appended to `logs/mcp-grafana.jsonl` on disk if you want the receipts.

### ⏸ The approval gate — the part that matters

At step 7 the run **stops** and a panel appears:

```
☑ a-f-NH-118-reprioritize — reprioritize
☑ a-f-NH-118-annotate — annotate
☑ a-f-NH-122-reprioritize — reprioritize
   …
[ Approve selected (19) ]   [ Reject all ]
```

Each id encodes the finding it came from (`a-` + finding id + what it does).

Every proposed action is listed with a checkbox, **all ticked by default**. The
agent has decided what it wants to do to Maya's Grafana — and it cannot do any
of it until she says so.

Take a moment here. This is Maya's actual job: not "did the AI find something"
but "am I willing to let it touch the board the whole team watches".

Your options:

- **Untick anything you do not want.** The counter in the button updates.
- **Approve selected (N)** — applies exactly the ticked actions.
- **Reject all** — applies nothing. The run still completes; you still get the
  findings and the explanation. You just get zero writes.

**For this walkthrough, click `Approve selected (N)`** — take whatever
number the button shows. The panel disappears, the last two steps finish, and the screen flips
to the result.

The control cannot be clicked twice — approval happens exactly once per run, by
construction.

> Want to see the other path? Do a second run later and press **Reject all**.
> You will get the same diagnosis with *Writes applied: 0* — a dry run.

---

## Part 6 — Reading the answer

You are now on the **result screen**.

### The counters

```
   18            4              19
 Blocked       High      Writes applied
```

*(Illustrative — your numbers depend on what the telemetry says. With the
seeded corpus and the default window, expect ~18 blocked shots, all from the
HELIOSFORGE vendor's render queue.)*

That is the headline Maya carries into the meeting: this many shots cannot make
dailies, this many more are at risk, and this many corrective actions are
already live on the dashboard.

### Findings

Below, one card per finding:

```
f-NH-118   shot: NH-118   level: blocked   rules: R-QUEUE
  • sustained queue-latency breach for HELIOSFORGE in the incident window
  • delivery commitment due before dailies, shot still unapproved
  [citations]
```

Read one carefully. It names **the shot**, **the severity**, **the rule that
fired** (`R-QUEUE`, `R-FAILRUN`, `R-FANOUT`, `R-ALERT`, `R-INCIDENT`,
`R-COMMIT`, `R-TREND`), the human reasons, and citations back to the evidence
and the memo commitments.

The rules are deterministic Python — `engine/diagnose/rules.py`. Gemini
explains and cites; it does not decide whether a shot is blocked. That
distinction is why Maya can defend this in a meeting.

### Writes applied — go look at Grafana

Each write shows a receipt:

```
a-f-NH-118-annotate: written via create_annotation (path: mcp)   Open in Grafana
```

`create_annotation` is the Grafana MCP tool that did it, and `path: mcp` says
it went through the MCP server rather than the REST fallback.

**Click "Open in Grafana".** It opens the dashboard at the annotated panel.

Now switch to your Grafana tab (<http://127.0.0.1:3000>) and open
**CineOps — NEON HOLLOW render queue**. On the latency panel you will see the
annotation marker the agent just created. Hover it: the incident note is there,
in Maya's dashboard, where her team looks — not buried in a chat log.

*This is the moment the demo lands.* The agent did not just answer a question;
it left a durable trace on the team's shared board, with a human's approval
attached.

### Hours saved

```
Hours saved: 3.5
```

The estimated coordinator time the top re-prioritisation avoids.

### Revised schedule

A table of the reordered shots — shot, status, priority, due, vendor.

### Step 3 — Export it

Click **Download revised schedule CSV**. Your browser saves
`revised-schedule-xxxxxxxx.csv` (the suffix is the run's trace id). Open it:

```
shot_id,production,status,priority,due_at,action,recommended_note
NH-118,NEON HOLLOW,failed,1,2026-09-05T08:00:00Z,reprioritize,Sustained queue ...
```

That file is what Maya sends the render wrangler. The walkthrough's real-world
output is this CSV plus the Grafana annotation.

> If the button is greyed out, this run produced no actions — you pressed
> *Reject all*, or the run was fully degraded. Hover it for the reason.

### Start over

**Back to ingest** returns you to the form for another question. Try
narrowing the window, or raising the severity floor to `high` to see fewer,
sharper findings.

---

## Part 7 — The 7am disaster rehearsal (optional but worth 2 minutes)

What happens when the venue wifi dies and Vertex, BigQuery and Grafana are all
unreachable? Not a blank screen.

Stop the server (`Ctrl+C`) and restart it with the kill switch on, in a shell
with **no** credentials:

*Git Bash:*

```bash
RES_FORCED_DEGRADED=1 python3 -m uvicorn engine.api.app:app --host 127.0.0.1 --port 8081 --timeout-keep-alive 75
```

*PowerShell:*

```powershell
$env:RES_FORCED_DEGRADED = "1"
python3 -m uvicorn engine.api.app:app --host 127.0.0.1 --port 8081 --timeout-keep-alive 75
```

Open <http://127.0.0.1:8081> and run the same flow. You will see:

- the pill reads **● degraded**, honestly
- *Load demo production* reports *"Seed degraded … — continuing from local
  corpus"* and the run proceeds anyway
- a **degraded banner** across the run screen naming what fell back
- the run still reaches the result screen with real findings, because the rules
  are pure Python and need no network
- the CSV button is disabled — there are no live actions, and the app says so
  instead of exporting something hollow

Nothing pretends. That is the design: **degrade visibly, never blank, never
lie.** Stop this server and go back to the normal one when you are done
(`$env:RES_FORCED_DEGRADED = ""` in PowerShell, or just open a fresh shell).

---

## Part 8 — Run it as the container / deploy it

The judge-facing artifact is a container. Build and run exactly what deploys:

```bash
docker build -t cineops-guardian:local .
docker run --rm -p 8099:8080 -e PORT=8080 \
  -e GOOGLE_GENAI_USE_VERTEXAI=true \
  -e GOOGLE_CLOUD_PROJECT=<your-gcp-project-id> \
  -e GOOGLE_CLOUD_LOCATION=us-central1 \
  cineops-guardian:local
```

Then <http://127.0.0.1:8099>. (Credentials inside a container need a mounted
ADC file or a service account; for a full live run the local server of Part 3
is simpler.)

To publish it and get a shareable URL:

```bash
PROJECT_ID=<your-gcp-project-id> REGION=us-central1 npm run deploy:cloudrun
```

The script prints `PUBLIC_URL=…` and pings `/api/health` three times. Read
[`docs/DEPLOY.md`](../../docs/DEPLOY.md) first — it lists the four IAM roles and
the one Secret Manager secret you need in place beforehand.

---

## Part 9 — Re-running the automated proof

Everything you just did by hand is also driven automatically in a real browser:

```bash
npm run build:ui
npx playwright test --config design_documents/e2e-testing/playwright.config.ts
```

Expect `5 passed`. Copy `design_documents/e2e-testing/.env.e2e.example` to
`.env.e2e` and fill it in first. The strategy, the use-case matrix and the
defect log are in
[`design_documents/e2e-testing/STRATEGY.md`](../e2e-testing/STRATEGY.md).

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Pill stuck on `● checking` | first health poll still in flight (the first Vertex call warms a client, ~15 s) | wait 30 s; then check the server terminal |
| `gemini:unknown` | ADC missing or wrong project/location | `gcloud auth application-default login`; confirm `GOOGLE_CLOUD_PROJECT`; `GOOGLE_CLOUD_LOCATION=us-central1` |
| `grafana-mcp:unknown` | the MCP binary was not found | check `MCP_GRAFANA_BIN` points at a real file; `curl -s localhost:8080/api/health` shows the launch error |
| `bigquery:unknown` | no BigQuery permission on the project | grant BigQuery Data Editor + Job User |
| Blank page at `/` | `dist/` not built | `npm run build:ui`, then reload |
| *Load demo production* 502s | BigQuery unreachable | fix credentials, or continue — the run works from the local corpus |
| Run finishes with 0 findings above `ok` | telemetry never seeded, so Grafana had no data | run `seed_local_telemetry.py` (step 2.2) and try again |
| No evidence cards during step 3 | MCP down; the run degraded | see `grafana-mcp` above |
| Approve button never appears | run errored earlier | read the server terminal; the run screen also shows *Run failed: …* |
| CSV button greyed out | zero actions — rejected, or fully degraded | hover it for the reason |
| Grafana login fails | wrong password | `admin` / `cineops-e2e-local` as set in step 2.1 |

---

## Shutting down

```bash
# Ctrl+C in the server terminal, then:
docker stop cineops-grafana cineops-prom cineops-loki
```

Use `docker start cineops-grafana cineops-prom cineops-loki` next time — the
seeded telemetry and your service-account token survive restarts, so your next
session begins at **Part 3**.
