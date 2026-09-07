# Real-life example artifacts — PALS (demo production)

> These are what the machine-readable demo files in `engine/rag/corpus/` look
> like **before they become codes**: the human-authored documents a real indie
> production passes around, and small readable samples of the machine exports.
> Every sample is synthetic and consistent with the shipped corpus (production
> `PALS`, incident window 2026-09-04 14:00–15:30 UTC, vendor HELIOSFORGE).

| File | What it is in real life | Who writes it, with what | App role |
|---|---|---|---|
| `PALS-call-sheet-day12.md` | Daily call sheet: who, where, when, what is shot | 1st AD, in Movie Magic / Caselite / Google Docs, emailed nightly | Context upload (optional). Proves *intent*: what was supposed to happen. |
| `PALS-vfx-delivery-memo-alpha.md` | VFX delivery memo: turnover promise per deliverable | VFX coordinator, in Docs/email with spreadsheet attached | Parsed by Gemini multimodally (`extract_commitments`); joined to telemetry by the rules. |
| `PALS-shot-list-sample.csv` | VFX shot list excerpt (10 of 240 rows) | Post-production coordinator (Maya!), in Excel/Sheets, exported to CSV | Deterministic parse (`extract_shot_list`, no LLM). **This exact file can be uploaded in the app.** |
| `PALS-render-queue-sample.csv` | Render-farm queue export excerpt | Render wrangler / farm software (Deadline, OpenCue) CSV export | Persisted to BigQuery; the shape Grafana queries aggregate. |
| `PALS-failed-jobs-sample.jsonl` | Failed render-job log lines | The render nodes themselves (Loki/Promtail scrape them) | Searched live via MCP (`query_loki_logs`); correlated by rule R-FAILRUN. |
| `PALS-grafana-setup.md` | Dashboard + alert rule, as built by clicking in Grafana | Whoever owns observability (here: Maya wearing a second hat), in the Grafana UI | `grafana/dashboard.json` + `alert-rules.yaml` are the *exports* of this clicking. Annotated back by the agent on approval. |

Reading order for humans: call sheet → memo → shot list → metrics → logs → grafana setup.
That is also the order the agent joins them: intent → commitments → shots → telemetry → evidence → write-back.
