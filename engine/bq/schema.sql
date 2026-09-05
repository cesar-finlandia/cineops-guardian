-- CineOps Guardian — BigQuery state layer (DP-BQ §3.1). Storage + SQL only. No BigQuery ML.
-- Dataset: cineops (== settings.bq_dataset default). Four tables. Copy verbatim.

CREATE TABLE IF NOT EXISTS `cineops.shots` (
  shot_id STRING NOT NULL,
  production STRING NOT NULL,
  episode_or_reel STRING NOT NULL,
  scene STRING NOT NULL,
  vfx_vendor STRING,
  status STRING NOT NULL,
  priority INT64 NOT NULL,
  due_at TIMESTAMP NOT NULL,
  render_job_id STRING,
  dependency_shot_ids ARRAY<STRING>,
  synthetic BOOL NOT NULL,
  loaded_at TIMESTAMP NOT NULL
)
CLUSTER BY production, status;

CREATE TABLE IF NOT EXISTS `cineops.render_queue_metrics` (
  ts TIMESTAMP NOT NULL,
  production STRING NOT NULL,
  job_id STRING NOT NULL,
  shot_id STRING NOT NULL,
  queue_latency_sec FLOAT64 NOT NULL,
  status STRING NOT NULL,
  vendor STRING NOT NULL,
  synthetic BOOL NOT NULL
)
PARTITION BY DATE(ts)
CLUSTER BY production, status;

CREATE TABLE IF NOT EXISTS `cineops.evidence_snapshots` (
  trace_id STRING NOT NULL,
  evidence_id STRING NOT NULL,
  kind STRING NOT NULL,
  mcp_tool STRING NOT NULL,
  args JSON,
  row_count INT64 NOT NULL,
  took_ms INT64 NOT NULL,
  degraded BOOL NOT NULL,
  rows_json JSON,
  captured_at TIMESTAMP NOT NULL
)
PARTITION BY DATE(captured_at)
CLUSTER BY trace_id, kind;

CREATE TABLE IF NOT EXISTS `cineops.remediation_log` (
  trace_id STRING NOT NULL,
  action_id STRING NOT NULL,
  ok BOOL NOT NULL,
  mcp_tool STRING NOT NULL,
  path STRING NOT NULL,
  remote_id STRING,
  grafana_link STRING,
  error STRING,
  written_at TIMESTAMP NOT NULL
)
CLUSTER BY trace_id;
