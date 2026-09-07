# PALS Grafana setup — what was clicked, what got exported

> Nobody hand-writes `grafana/dashboard.json` or `grafana/alert-rules.yaml`.
> A human builds them by clicking in the Grafana UI; the JSON/YAML are the
> **exports** of that clicking (Dashboard settings → JSON model; Alerting →
> Export). The agent annotates the dashboard back through the same product at
> runtime. What follows is the exact clicking, so the exports stop looking alien.

## Dashboard: "CineOps — PALS render queue" (uid `cineops-render-queue`)

Built in Grafana → Dashboards → New → Add visualization, twice:

1. **Panel 1 — "Render queue latency (p95, sec)"**, timeseries, Prometheus datasource:
   ```promql
   histogram_quantile(0.95, sum by (le, vendor) (
     rate(cineops_render_queue_latency_seconds_bucket{production="PALS"}[$__rate_interval])
   ))
   ```
   This is the panel the agent annotates (panel id 1) — the before/after
   screenshot in your trailer.
2. **Panel 2 — "Failed jobs"**, table, Loki datasource:
   ```logql
   {production="PALS"} |= "failed"
   ```
   Same query family the agent runs live through the MCP server.

Save, then Dashboard settings → JSON model → that text is `grafana/dashboard.json`.

## Alert rule: "p95 latency high" (uid `cineops-p95-latency-high`)

Built in Grafana → Alerting → Alert rules → New rule: same PromQL as Panel 1,
condition "WHEN last() OF query (A, 5m, now) IS ABOVE 300", labels
`production=PALS, severity=critical`, annotation summarizing the synthetic-data
disclaimer. Alerting → Export → that text is `grafana/alert-rules.yaml`.

## The two UIDs the app must know

`engine/rag/corpus/CORPUS.json` records `dashboard_uid` + `panel_id` — that is
how the agent's annotation lands on panel 1 instead of nowhere. If you ever
re-provision the dashboard by hand, keep the uid `cineops-render-queue` or
update CORPUS.json to match.
