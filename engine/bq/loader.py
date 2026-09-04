# CineOps Guardian — BigQuery state layer (DP-BQ §3.2). Storage + SQL only.
# No Grafana import. No BigQuery ML. No os.environ. No retry/backoff of its own
# (DP-GUARD @guarded only).
from __future__ import annotations

import csv
import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from google.cloud import bigquery

from engine.runtime.config import settings
from engine.runtime.guard import guarded, unwrap
from engine.schema.domain import ProductionShot, GrafanaEvidence, WriteReceipt
from src.resilience.degraded import is_degraded_result

_logger = logging.getLogger("engine.bq.loader")

SCHEMA_SQL_PATH: str = str(Path(__file__).resolve().parent / "schema.sql")

SNAPSHOT_MAX_ROWS: int = 100
LOAD_BATCH_SIZE: int = 500
TREND_DEFAULT_DAYS: int = 7

_CLIENT: bigquery.Client | None = None


def _client() -> bigquery.Client:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = bigquery.Client(
            project=settings.gcp_project or None,
            location=settings.gcp_location or None,
        )
    return _CLIENT


def _table_id(table: str) -> str:
    return f"{settings.gcp_project}.{settings.bq_dataset}.{table}"


def ensure_dataset() -> None:
    client = _client()
    dataset_ref = bigquery.DatasetReference(settings.gcp_project, settings.bq_dataset)
    try:
        client.get_dataset(dataset_ref)
    except Exception:
        client.create_dataset(
            bigquery.Dataset(dataset_ref),
            location=settings.gcp_location or None,
            exists_ok=True,
        )
    sql = Path(SCHEMA_SQL_PATH).read_text(encoding="utf-8")
    if settings.bq_dataset != "cineops":
        sql = sql.replace("`cineops.", f"`{settings.bq_dataset}.")
    statements = [
        s.strip()
        for s in sql.split(";")
        if s.strip() and ("CREATE TABLE" in s)
    ]
    for stmt in statements:
        client.query(stmt).result()
    return None


@guarded("bq-load-corpus", provider="google")
def load_corpus(corpus_dir: str, *, production: str) -> dict:
    client = _client()
    shots_csv = Path(corpus_dir) / "shots" / "shot_list.csv"
    metrics_csv = Path(corpus_dir) / "telemetry" / "render_queue_metrics.csv"
    # Missing file propagates into @guarded as DegradedResult.
    with open(shots_csv, "r", encoding="utf-8", newline="") as fh:
        shot_rows = list(csv.DictReader(fh))
    with open(metrics_csv, "r", encoding="utf-8", newline="") as fh:
        metric_rows = list(csv.DictReader(fh))

    shot_inserts: list[dict] = []
    for row in shot_rows:
        if row.get("production") != production:
            continue
        due_raw = (row.get("due_at") or "").strip()
        if not due_raw:
            raise ValueError("shot due_at missing")
        due_at = datetime.fromisoformat(due_raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        deps_raw = row.get("dependency_shot_ids")
        deps = [p.strip() for p in str(deps_raw or "").split(";") if p.strip()]
        vfx = (row.get("vfx_vendor") or "").strip() or None
        rjob = (row.get("render_job_id") or "").strip() or None
        shot_dict = {
            "shot_id": (row.get("shot_id") or "").strip(),
            "production": production,
            "episode_or_reel": (row.get("episode_or_reel") or "").strip(),
            "scene": (row.get("scene") or "").strip(),
            "vfx_vendor": vfx,
            "status": (row.get("status") or "").strip(),
            "priority": int(row["priority"]),
            "due_at": due_at,
            "render_job_id": rjob,
            "dependency_shot_ids": deps,
            "synthetic": True,
        }
        try:
            ProductionShot(**shot_dict)
        except Exception:
            continue
        shot_inserts.append(
            {**shot_dict, "loaded_at": datetime.now(timezone.utc).isoformat()}
        )

    metric_inserts: list[dict] = []
    for row in metric_rows:
        if row.get("production") != production:
            continue
        ts_raw = (row.get("ts") or "").strip()
        if not ts_raw:
            raise ValueError("metric ts missing")
        ts = datetime.fromisoformat(ts_raw.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
        metric_inserts.append(
            {
                "ts": ts,
                "production": production,
                "job_id": (row.get("job_id") or "").strip(),
                "shot_id": (row.get("shot_id") or "").strip(),
                "queue_latency_sec": float(row["queue_latency_sec"]),
                "status": (row.get("status") or "").strip(),
                "vendor": (row.get("vendor") or "").strip(),
                "synthetic": True,
            }
        )

    for table, col in (("shots", "shots"), ("render_queue_metrics", "metrics")):
        _ = col
        client.query(
            f"DELETE FROM `{_table_id(table)}` WHERE production = @p",
            job_config=bigquery.QueryJobConfig(
                query_parameters=[
                    bigquery.ScalarQueryParameter("p", "STRING", production)
                ]
            ),
        ).result()

    for inserts, table in ((shot_inserts, "shots"), (metric_inserts, "render_queue_metrics")):
        for i in range(0, len(inserts), LOAD_BATCH_SIZE):
            batch = inserts[i : i + LOAD_BATCH_SIZE]
            if not batch:
                continue
            errors = client.insert_rows_json(_table_id(table), batch)
            if errors:
                raise RuntimeError(str(errors))
    return {"shots": len(shot_inserts), "metrics": len(metric_inserts)}


@guarded("bq-persist-snapshot", provider="google")
def persist_snapshot(trace_id: str, evidence: list[GrafanaEvidence]) -> dict:
    if not evidence:
        return {"rows": 0, "table": "evidence_snapshots"}
    client = _client()
    now_iso = datetime.now(timezone.utc).isoformat()
    rows: list[dict] = []
    for e in evidence:
        truncated = list(e.rows[:SNAPSHOT_MAX_ROWS])
        rows.append(
            {
                "trace_id": trace_id,
                "evidence_id": e.evidence_id,
                "kind": e.kind,
                "mcp_tool": e.mcp_tool,
                "args": json.dumps(e.args, sort_keys=True, separators=(",", ":"), default=str),
                "row_count": e.row_count,
                "took_ms": e.took_ms,
                "degraded": e.degraded,
                "rows": json.dumps(truncated, sort_keys=False, separators=(",", ":"), default=str),
                "captured_at": now_iso,
            }
        )
    errors = client.insert_rows_json(_table_id("evidence_snapshots"), rows)
    if errors:
        raise RuntimeError(str(errors))
    return {"rows": len(rows), "table": "evidence_snapshots"}


@guarded("bq-persist-remediation", provider="google")
def persist_remediation(trace_id: str, receipts: list[WriteReceipt]) -> dict:
    if not receipts:
        return {"rows": 0}
    client = _client()
    now_iso = datetime.now(timezone.utc).isoformat()
    rows = [
        {
            "trace_id": trace_id,
            "action_id": r.action_id,
            "ok": r.ok,
            "mcp_tool": r.mcp_tool,
            "path": r.path,
            "remote_id": r.remote_id,
            "grafana_link": r.grafana_link,
            "error": r.error,
            "written_at": now_iso,
        }
        for r in receipts
    ]
    errors = client.insert_rows_json(_table_id("remediation_log"), rows)
    if errors:
        raise RuntimeError(str(errors))
    return {"rows": len(rows)}


@guarded("bq-query-trend", provider="google")
def query_trend(production: str, *, days: int = 7) -> list[dict]:
    if days is None or days <= 0:
        days = TREND_DEFAULT_DAYS
    client = _client()
    table = _table_id("render_queue_metrics")
    sql = (
        "SELECT DATE(ts) AS day, COUNTIF(status = 'failed') AS failed_jobs, "
        "APPROX_QUANTILES(queue_latency_sec, 100)[OFFSET(95)] AS p95_latency_sec "
        f"FROM `{table}` WHERE production = @production "
        "AND ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY) "
        "GROUP BY day ORDER BY day ASC"
    )
    job_config = bigquery.QueryJobConfig(
        query_parameters=[
            bigquery.ScalarQueryParameter("production", "STRING", production),
            bigquery.ScalarQueryParameter("days", "INT64", days),
        ]
    )
    result = client.query(sql, job_config=job_config).result()
    out: list[dict] = []
    for row in result:
        day = row.day.isoformat() if hasattr(row.day, "isoformat") else str(row.day)
        out.append(
            {
                "day": day,
                "failed_jobs": int(row.failed_jobs),
                "p95_latency_sec": float(row.p95_latency_sec)
                if row.p95_latency_sec is not None
                else 0.0,
            }
        )
    return out


def bq_health() -> dict:
    try:
        client = _client()
        tables = sorted(
            t.table_id for t in client.list_tables(f"{settings.gcp_project}.{settings.bq_dataset}")
        )
        return {
            "reachable": True,
            "dataset": settings.bq_dataset,
            "tables": tables,
            "last_error": None,
        }
    except Exception as err:
        _logger.warning("[bq] health probe failed (%s)", err)
        return {
            "reachable": False,
            "dataset": settings.bq_dataset,
            "tables": [],
            "last_error": f"{type(err).__name__}: {err}",
        }
