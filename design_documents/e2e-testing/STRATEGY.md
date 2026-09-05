# E2E Testing Strategy — CineOps Guardian (delivery gate)

> Location: `design_documents/e2e-testing/` (shipped to GitHub via `.gitignore`
> exception — this directory is delivery evidence, not planning scratch).
> Runner: Playwright + real Chromium against the real FastAPI backend serving
> the real `dist/` build — the exact artifact `Dockerfile` ships to Cloud Run.

## 1. Goal

Take the entry from "implemented" to "ready for hackathon delivery": prove,
through a real web browser, that Maya (post-production coordinator) can
complete every use case from the design plans against a running backend, fix
whatever fails, and leave the repo in a state where `docker build` + one
deploy script produce the judge-facing URL.

Source of truth for expected behaviour: `design_documents/master_blueprint_entry.md`
(FR-01..FR-14, NFR-01..NFR-08, CMP-01..CMP-10) and the DP plan that owns each
work unit. Where a test and the code disagree, the use case decides
(end-user purpose first).

## 2. Tiers

| Tier | Backend env | What it proves | Where |
|---|---|---|---|
| **T0 golden/offline** | `RES_FORCED_DEGRADED=1`, no creds, port 8081 | NFR-01/NFR-02: boot with zero network, full run completes degraded, banner shown, no blank screen anywhere | `e2e/golden-fallback.spec.ts` (spawns its own server) |
| **T1 live-local (PRIMARY)** | Vertex ADC + local Grafana OSS + live BQ dataset, port 8080 | FR-01..FR-14 happy path + approval gate + real MCP reads/writes + real Gemini extraction, all in-browser | `e2e/main-flow.spec.ts`, `e2e/edges.spec.ts` |
| **T2 deploy** | Cloud Run image | `docker build` succeeds; container serves `/` + `/api/health`; `scripts/deploy-cloudrun.sh` is the only deploy path | runbook §6 (manual, needs `PROJECT_ID`/`REGION`) |
| **T3 judge-repro** | PUBLIC_URL | judge repeats UC-02→UC-06 with no files of their own | `docs/SPINUP.md` + Devpost text |

T1 is the automated gate. T0 is the automated fallback proof (stage Wi-Fi dies).
T2/T3 are manual checklists because they need GCP project access / a camera.

## 3. Environment (T1) — Vertex, never API keys

Per owner preference, Gemini access is **Vertex AI via ADC only**. No
`GOOGLE_API_KEY`, no AI Studio key, no key file in the repo.

| Variable | Value (this machine) | Why |
|---|---|---|
| `GOOGLE_CLOUD_PROJECT` | `project-ff181f80-9ef1-457b-951` | ADC quota project (from `gcloud auth list`) |
| `GOOGLE_CLOUD_LOCATION` | `us-central1` | Vertex region; empty/`global` 404s (probed) |
| `GEMINI_MODEL` | `gemini-2.5-flash` | **`gemini-2.0-flash` is retired on Vertex in 2026** (404 in `us-central1` and `global`, probed 2026-09-04). Blueprint intent = "current Gemini Flash on Vertex, temp 0"; the pinned default stays in code (DP-CONFIG/DP-GEMINI verified it) and the deploy env overrides it. No non-Google model involved — CMP-04 safe. |
| `GRAFANA_STACK_URL` | `http://127.0.0.1:3000` | local Grafana OSS (docker), §5 |
| `GRAFANA_SERVICE_ACCOUNT_TOKEN` | `<local SA token>` | created via Grafana API, Admin role, never committed |
| `GRAFANA_TRANSPORT` | `stdio` | `mcp-grafana` binary on PATH (or `MCP_GRAFANA_BIN`), §5 |
| `BQ_DATASET` | `cineops` | created by `ensure_dataset()` on boot (live ADC) |
| `RES_FORCED_DEGRADED` | unset (T1) / `1` (T0) | golden-cache kill switch |

`.env.e2e.example` documents the shape with empty secrets. Real values live
only in the operator's shell (and later in Secret Manager, never in git).

## 4. Use-case matrix (every FR/NFR with a browser proof)

Maya's story: *"which shots are blocked for tomorrow's dailies and why?"*

| UC | Covers | Browser proof (assertions) | Spec |
|---|---|---|---|
| UC-01 open app, backend liveness | NFR-01, DP-UI A7 | `/` serves title "CineOps Guardian"; `health-pill` leaves `checking` ≤30 s; pill shows `gemini:ok grafana-mcp:ok bigquery:ok` (T1) | main-flow |
| UC-02 load demo production | FR-01/FR-13, DP-UI A2, DP-API `/api/seed`, DP-BQ `load_corpus` | click `seed-btn` → `POST /api/seed` returns `{shots:240, metrics:8064}`; button re-enables | main-flow |
| UC-03 start diagnosis | FR-01, DP-UI A2, DP-API `/api/run` | click `diagnose-btn` → screen flips to `data-screen="run"`; `connecting` resolves to live stream | main-flow |
| UC-04 watch the 8-step run | FR-10/FR-12, DP-AGENT 8 steps, DP-API envelopes | all 8 `STEP_IDS` reach `done` in the step list; every collected envelope validates against `contracts/event-envelope.schema.json` (ajv, in-browser collection via `EventSource`); `sequence` monotone per `trace_id` | main-flow |
| UC-05 Grafana evidence on screen | FR-04/FR-05, CMP-03, DP-MCP | ≥1 `evidence-tool` card showing a real MCP tool name (e.g. `search_dashboards`); `logs/mcp-grafana.jsonl` gains `path:"mcp"` lines for the run | main-flow |
| UC-06 approve the writes | FR-09/FR-14, DP-AGENT A7 | `approve-btn` appears with all actions pre-checked; click → control disables permanently; `POST /api/approve` returns `{released:N>0}` exactly once | main-flow |
| UC-07 review results | FR-08/FR-11, DP-DIAG | `data-screen="result"`; ≥1 `.cineops-finding-row` with level/rules/reasons; `hours-saved` numeric; ≥1 receipt `written` with `grafana-link` pointing at the stack; revised `.cineops-shot-table` non-empty | main-flow |
| UC-08 export revised schedule | FR-11, DP-UI A6 | `csv-download` click → file `revised-schedule-*.csv`; header exactly `shot_id,production,status,priority,due_at,action,recommended_note`; ≥1 data row | main-flow |
| UC-09 reject path | FR-14 (negative), DP-API `release` | fresh run via API → `awaiting-approval` → approve `[]` → `{released:0}` → run still reaches `done` with `receipts:[]` (no writes) | edges |
| UC-10 upload validation | FR-01/FR-03, DP-API `/api/upload` | valid CSV → 200 + `paths`; `.txt` → 400; oversize → 413; UI file input `accept` matches server allowlist (`.pdf,.csv`) | edges |
| UC-11 API edge contract | DP-API §6 failure modes | unknown `trace_id` → 404 on result + approve; second approve after done → `{released:0}` (no double-write); `/api/health` shape has all six keys | edges |
| UC-12 offline honesty | NFR-01/NFR-02, DP-GUARD | T0 server boots with no creds; full run reaches `done`; `degraded-banner` visible; findings present (pure-Python rules); zero actions → CSV disabled; no blank screen on any screen | golden-fallback |

Out-of-browser scope (documented, not automated): FR-06 trend comparison across
runs (needs ≥2 live runs + BQ console eyeball — covered once manually in §6),
NFR-05 wall-clock budgets (measured once manually), CMP-07 video (camera).

## 5. Local Grafana stack (track-gate proof without a Cloud account)

Grafana Cloud free tier needs a human signup, so T1 uses Grafana OSS in docker
— same MCP surface (`grafana/mcp-grafana` binary, stdio transport):

```powershell
docker run -d --name cineops-grafana -p 3000:3000 `
  -e GF_SECURITY_ADMIN_USER=admin -e GF_SECURITY_ADMIN_PASSWORD=<local-only> `
  grafana/grafana-oss:11.5.2
# service account + token (Admin) via Grafana HTTP API, then:
#   $env:GRAFANA_STACK_URL='http://127.0.0.1:3000'
#   $env:GRAFANA_SERVICE_ACCOUNT_TOKEN='<token>'
#   $env:GRAFANA_TRANSPORT='stdio'   (+ mcp-grafana binary on PATH)
```

`scripts/seed-grafana.ts` provisions the `cineops-render-queue` dashboard +
alert rule from `grafana/`; the annotation write-back lands on that dashboard
and the test asserts the deep link. Datasources absent locally (no Prometheus/
Loki) → metrics/logs kinds degrade honestly per-step while dashboards/alerts/
annotations go through — a real partial-degradation workout, not a mock.

E2E-LOCAL FULL TELEMETRY (F15): `design_documents/e2e-testing/telemetry/
seed_local_telemetry.py` stands up `prom/prometheus` (corpus CSV converted to
OpenMetrics, loaded via `promtool create-blocks-from`) and `grafana/loki`
(corpus JSONL pushed over HTTP), then provisions both as Grafana datasources.
With real series/streams, R-QUEUE/R-FAILRUN fire (18 blocked HELIOSFORGE
shots) and remediation/approval/write-back run for real. Re-run it whenever
the docker stack is rebuilt; it is idempotent. Containers + volumes are
local-only and never committed.

## 6. Execution

```powershell
npm run build:ui
npx playwright test --config design_documents/e2e-testing/playwright.config.ts
```

The config resolves the `mcp-grafana` binary itself (`E2E_MCP_GRAFANA_BIN` →
repo-local `.e2e-bin/` → `PATH`) and passes it as `MCP_GRAFANA_BIN`, so the
gate does not depend on the operator's shell (F19).

Playwright `webServer` boots the T1 backend
(`python3 -m uvicorn engine.api.app:app --host 127.0.0.1 --port 8080`) with env
from §3; T0 spec spawns port 8081 itself. Full suite ≈ 10–20 min (two live
Gemini runs + one golden run). Re-run: `npx playwright test --retries 0` after
fixes; green = all specs pass consecutively, no `.only`, no skipped UC.

Manual T2 checklist (once, on the deploy machine): `docker build -t
cineops-guardian:e2e .` → run with env → `GET /api/health` 200 → `GET /`
serves title → `PROJECT_ID=… REGION=… npm run deploy:cloudrun`.

## 7. Defect log (grows during §6 execution)

| id | Found by | Symptom | Root cause | Fix (use-case reasoning) | Status |
|---|---|---|---|---|---|
| F1 | boot probe | uvicorn stuck at "Waiting for application startup", no route serves | `app.startup → ensure_dataset()` unguarded; BQ unreachable off-GCP | DP-API owns the seam: bound the call (`wait_for` 20 s, `to_thread`) + log-and-continue. Deploy-time `ensure_dataset()` (script) still fails loudly — Maya must never see a dead boot, the operator must still see a failed provision. | fixed, re-verified |
| F2 | code review vs DP-API allowlist | UI file input `accept=".pdf,.csv,.txt"` but server allows `{.csv,.pdf}` → `.txt` passes the picker then 400s | frontend/backend allowlist drift | Aligned UI to the server (ingest only processes CSV shot lists + PDF memos; `.txt` has no consumer). User purpose: never offer what will be rejected. | fixed |
| F3 | Vertex probe | `gemini-2.0-flash` 404 on Vertex (`global` + `us-central1`) | model retired 2026 | Env override `GEMINI_MODEL=gemini-2.5-flash` + `GOOGLE_CLOUD_LOCATION=us-central1` for T1/deploy; code default untouched (DP-CONFIG/DP-GEMINI verified). Verified `TEXT: OK` live. | env fix, verified |
| F4 | T0 dry-run reasoning | `/api/seed` 502s offline (BQ unreachable) and `App.onStart` aborted the whole run → offline fallback rung bricked | seed (cloud provision) treated as hard precondition for a run that only needs local CSVs | `App.onStart`/`onSeed` warn-but-continue: seed failure sets a visible `role="alert"` notice, the run proceeds from the local corpus and degrades honestly per-step. Never block Maya on a provisioning nicety; never hide the failure either. | fixed, UC-12 asserts |
| F5 | T1 health probe | `bigquery:unknown`, dataset never created | `ensure_dataset()` passed `location=` kwarg that `create_dataset()` has no such parameter → TypeError on every boot | Set `dataset.location` on the `Dataset` object (the API's actual surface). Operator intent: boot self-provisions. | fixed, re-verified |
| F6 | T1 ensure | `NOT NULL cannot be applied to ARRAY field 'dependency_shot_ids'` | BigQuery forbids NOT NULL on ARRAY columns; schema never validated live | Dropped `NOT NULL` on the ARRAY column (DP-BQ owned file). | fixed, re-verified |
| F7 | T1 ensure | `Syntax error … got keyword ROWS` on `evidence_snapshots` DDL | `rows` is a reserved keyword | Renamed column to `rows_json` in `schema.sql` + the single writer (`persist_snapshot`); no readers affected. | fixed, re-verified |
| F8 | T1 seed re-run | `/api/seed` 502 `primary_failed`: DML DELETE over tables with rows in the streaming buffer is rejected for ~90 min | seed used DELETE+streaming-INSERT; any re-seed (incl. the test's own UI+API double seed) 502s | `load_corpus` now replaces via `WRITE_TRUNCATE` load jobs (truncate is buffer-safe). Re-seed verified twice consecutively: `{shots:240, metrics:8064}` both times. | fixed, re-verified |
| F9 | T1 diagnose UX | click Diagnose → still on ingest after 30 s (run start buried in a ~50 s re-seed, dead UI) | every Diagnose re-ran the full BQ reload; provisioning treated as precondition | `load_corpus(refresh=False)` fast-ensure path (COUNT check, no reload); `POST /api/seed` takes `refresh`; Seed button forces refresh, Diagnose ensures. Maya's run starts in seconds; provisioning honesty preserved (`refreshed` flag). | fixed, UC-02 asserts both paths |
| F10 | browser + curl probes | `POST /api/run` returns headers in ~10 ms but the 51-byte body arrives minutes later or never (5 min browser evaluate timeout; curl 12-25 s) | `run_diagnosis` does minutes of synchronous blocking I/O on the server event loop (BackgroundTasks task); starved loop never flushes the pending body/SSE/health — proven by 8 s-blocked mini repro delaying its own body 8.36 s | `_run_task` moved to a daemon worker thread with its own loop; SSE publish + approval gate bridged via `run_coroutine_threadsafe`. Loop stays free (health polls flow mid-run). Body now arrives in ~20 ms. | fixed, timing probe asserts |
| F11 | memo timing | one 1 KB memo extraction took ~67 s then degraded (sidecar), 6 memos ≈ 7 min | chassis 15 s post-join timeout + 2 retries vs 8-20 s raw Vertex multimodal latency → every slow success became 3× slow-burn + false timeout | Per-call resilience budgets at the engine seam (chassis untouched): structured 90 s/1 retry, text 60 s/1, propose (nests text) 120 s/1, MCP 60 s/1, `load_corpus` 300 s/1. Single slow success now ~19 s. | fixed, probe-verified |
| F12 | NFR-05 budget | sequential A1 ≈ 2-4 min alone (6 × ~20-40 s memo calls); full run can never fit 90 s | multimodal latency is per-file and independent | `tool_load_context` extracts memos via `ThreadPoolExecutor(6)` with order-preserving `ex.map` (deterministic) and per-file degrade-to-`[]`. | fixed, E2E asserts |
| F13 | browser + trace forensics | run completes server-side but UI never advances: approve never renders, steps stuck pending; SSE silent after ~15 s gaps | chassis SSE generator closes idle connections after 15 s (broadcast hub, no history); app reconnect wiped the buffer and stale `appliedRef` dropped post-reconnect envelopes | DP-API replay buffer (`RECENT` deque + `GET /api/events/recent`) + DP-UI merged/deduped envelope state with a 3 s gap-filling poller; `pollAlive` hides the stale stream-error line. Chassis untouched. | fixed, UC-04/UC-06 assert |
| F14 | MCP probes | `query_prometheus`/`query_loki_logs` isError on plan-style `{"query": ...}` args | real tools want `expr`/`logql` + `datasourceUid` + time bounds; plans carry provider-neutral args | `mcp_call` adapts inputs at the DP-MCP seam (arg rename, default datasource discovery, incident-window time defaults); explicit caller values win. | fixed, probe-verified |
| F15 | correlate probe | zero findings above `ok` despite live telemetry: rules never saw the data | MCP returns nested matrix/stream payloads (`{data: [{metric, values}]}` / `{data: [{line, labels}]}`); rules only read flat rows with numeric `value` | Central `_flatten_evidence_rows` + pair-parsing `_queue_stats` in DP-DIAG `rules.py` (old flat shapes behave identically). Result: 18 blocked (HELIOSFORGE R-QUEUE) + 19 actions. | fixed, probe-verified |
| F16 | UC-11 health assertion (intermittent) | `/api/health` reported `gemini.reachable:false` on ~25 % of polls while every real Gemini call worked — the pill told Maya the backend was down when it was not | the liveness probe asked for `max_output_tokens=8` from `gemini-2.5-flash`, a **thinking** model: the thought tokens consumed the whole budget, the response came back with `finish_reason=MAX_TOKENS` and no text part, and `reachable` was derived from that text | Probe with thinking disabled (`ThinkingConfig(thinking_budget=0)`) and real headroom, and define `reachable` as "Vertex answered" (no exception) rather than "the answer had text" — that is what Maya needs before pressing Diagnose. Negative results now expire in 5 s (vs 30 s) so a genuine blip self-heals on the next poll instead of freezing a red pill. Probed 10/10 reachable after the fix (was 6-8/10). | fixed, re-verified |
| F17 | UC-04 step assertion (strict-mode violation) | every step rendered **twice** on the run screen, and `li[data-step-id]` matched 2 elements | `RunScreen` rendered both the chassis `StepStatusIndicator` (steps seen so far, from envelopes) *and* a full hand-rolled 8-step `<ol>` — the same information stacked twice | The two lists now partition the run instead of duplicating it: the chassis component (read-only, mandated reuse) renders the steps the run has reached; the cineops list appends only the steps it has **not** reached, which the chassis component cannot express (its status enum has no `pending`). One `step_id`, one row — and all 8 steps are still visible from the first second, which is what Maya needs during a multi-minute run. | fixed, UC-04 asserts |
| F18 | server log during every live run | `golden cache put failed … Object of type GrafanaEvidence is not JSON serializable` (also `RemediationAction`) — the offline rung had no recorded evidence or actions to replay, silently defeating NFR-02 ("identical UI, identical envelopes" with zero network) | the golden cache stores JSON; the two seams that matter for the fallback demo return Pydantic models, so every `put` for them threw and was swallowed as a warning | DP-GUARD seam: `_cacheable()` dumps Pydantic models structurally before the put, and a new `revive=` hook on `@guarded` rehydrates a cache hit back into the declared type (no-op on live values and on `DegradedResult`s). Wired at `mcp_call` and `propose_remediation`. Zero cache warnings in the next full run. | fixed, re-verified |
| F19 | UC-11 + UC-01 (all-degraded run) | `grafana_mcp.reachable:false` — `mcp connect failed: [WinError 2] The system cannot find the file specified` — every MCP read degraded, from a shell whose PATH simply differed from the operator's | `_connect_stdio` hard-coded `command="mcp-grafana"`, so launching the server was silently a function of the caller's PATH. The strategy already claimed `MCP_GRAFANA_BIN` support that did not exist. | DP-CONFIG owns env: added `settings.grafana_mcp_bin` (`MCP_GRAFANA_BIN`, default `mcp-grafana`) and DP-MCP launches through it. `playwright.config.ts` resolves the binary itself — explicit override → repo-local `.e2e-bin/` → PATH — so the gate is reproducible from any shell, and `docs/SPINUP.md` documents the knob for judges. | fixed, re-verified |
| F20 | delivery review | a clean deploy that does not set `GEMINI_MODEL` would 404 on every model call | the pinned default was still the retired `gemini-2.0-flash` (F3 fixed the E2E env, not the default a judge inherits) | Default moved to `gemini-2.5-flash` in `engine/runtime/config.py` (and `config/model-profiles.json`, `README.md`, `disclosure.md` corrected to match what actually runs). Same family, same provider, still Vertex-only — CMP-04 unaffected. The blueprint's intent is "current Gemini Flash on Vertex, temp 0"; a default that 404s serves no user. | fixed |

| F21 | UC-09 (intermittent, confirmation run) | a polled `GET /api/result/{trace}` died with `read ECONNRESET`; the server logged no error and served the next request fine | uvicorn's `--timeout-keep-alive` default is **5 s** and the clients poll on a ~5 s cadence, so the server closes the idle keep-alive connection at the same instant the client reuses it. A browser retries an idempotent GET on a reused-connection close; a test's request context does not, and neither would a scripted judge | Both sides: raise the server keep-alive to 75 s in the container `CMD` and in both E2E server launches so the cadences stop colliding, and make the poll loop retry transport errors (up to 3, 1 s apart) the way a browser does. A run that is still going must never look like a failed run because a socket went idle. | fixed, re-verified |

| F22 | T2 container build | image built clean but logged `sse transport — skipping mcp-grafana binary`: the shipped container has no MCP launcher at all | `grafana/install-mcp-binary.sh` installed the binary only when `GRAFANA_TRANSPORT` was already `stdio` **at build time**, and nothing ever set it — `gcloud run deploy --source .` cannot pass a build arg, and `/app/grafana/.transport` is never written. So the engine's `auto` transport advertises a stdio fallback the container cannot perform | Install it by default, with `INSTALL_MCP_BINARY=0` (a Dockerfile `ARG`) as the lean opt-out. The judge-facing URL is the deliverable: if the hosted MCP endpoint hiccups mid-demo, the service must be able to fall back rather than sit degraded with no route back. ~30 MB on a 2 Gi service. | fixed: install by default, and the pin itself was broken — `v0.6.0/mcp-grafana_linux_amd64.tar.gz` 404s, so the very first build that actually ran the install failed (curl 22). Repinned to `v1.3.0/mcp-grafana_Linux_x86_64.tar.gz`, the exact version the gate drives locally. Image rebuilt and the binary verified inside it. |

## 8. Done criteria

- [x] all specs in this directory pass consecutively on this machine
      (`5 passed` twice in a row, 2026-09-05: runs 12 and 13; run 11 caught
      F21, the keep-alive race, which runs 12 and 13 re-verify)
- [x] every UC-01..UC-12 row has a passing assertion
      (UC-01..UC-08 main-flow, UC-09..UC-11 edges, UC-12 golden-fallback;
      FR-06 trend / NFR-05 budgets / CMP-07 video remain the documented
      manual proofs of §4)
- [x] defect log entries all `fixed` / `fixed, re-verified` (F1..F22)
- [x] `.gitignore` ships only delivery-relevant files: every path
      `run_sweep.sh` reads or writes is excluded (see the harness block, which
      names the driver variable behind each pattern), as are the E2E scratch
      logs and the downloaded MCP binary; `design_documents/` stays out except
      this directory, whose heavy run output (HTML report, traces, videos) and
      `.env.e2e` secrets are excluded in turn. `bash scripts/hygiene.sh` PASSes.
- [x] T2 container verified on this machine, not just reviewed:
      `docker build -t cineops-guardian:e2e .` succeeds; the image carries
      `mcp-grafana 1.3.0` (the version the gate drives) and `/app/dist/`;
      `docker run` serves `GET /` with `<title>CineOps Guardian</title>` and
      `GET /api/health` 200. `scripts/deploy-cloudrun.sh` now exports the
      Vertex env the runtime actually needs (`GOOGLE_GENAI_USE_VERTEXAI`,
      project, location, model, dataset) instead of leaving `google-adk` to
      fall back to API-key mode — F20 / `docs/DEPLOY.md`.

## 9. What is not automated here

- **T2 Cloud Run deploy** needs a GCP project, a service account with the four
  IAM roles, and the `grafana-service-account-token` secret. `docs/DEPLOY.md`
  is the checklist; `scripts/smoke-deploy.ts` verifies `PUBLIC_URL` afterwards.
- **T3 judge repro** is `docs/SPINUP.md` plus the deployed URL.
- **FR-06 trend across runs** needs ≥2 live runs plus a BigQuery eyeball;
  **NFR-05 wall-clock budgets** and **CMP-07 video** are measured/recorded once
  by hand. These are called out rather than silently skipped.
