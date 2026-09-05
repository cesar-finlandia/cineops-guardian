# E2E-LOCAL ONLY (never part of the shipped product): Prometheus + Loki
# telemetry for the demo corpus so MCP metrics/logs queries return real rows.
# The shipped `scripts/seed-grafana.ts` targets Grafana Cloud (hosted
# Prometheus/Loki); this machine uses local OSS + containers instead.
#
# Usage (from repo root):
#   python3 design_documents/e2e-testing/telemetry/seed_local_telemetry.py
#
# Steps: CSV -> OpenMetrics -> promtool blocks -> Loki push -> Grafana
# datasource provisioning. Idempotent: re-runs replace blocks/data in place.
import csv
import json
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TELEMETRY = ROOT / "engine" / "rag" / "corpus" / "telemetry"
WORK = Path(__file__).resolve().parent / ".work"
GRAFANA = "http://127.0.0.1:3000"
PROM = "http://127.0.0.1:9090"
LOKI = "http://127.0.0.1:3100"

ADMIN = ("admin", "cineops-e2e-local")  # local-only Grafana OSS credentials


def sh(cmd: list[str]) -> str:
    out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    if out.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd[:4])} failed: {out.stderr[:500]}")
    return out.stdout


def gapi(method: str, path: str, body: dict | None = None) -> dict:
    import base64

    token = base64.b64encode(f"{ADMIN[0]}:{ADMIN[1]}".encode()).decode()
    req = urllib.request.Request(
        GRAFANA + path,
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Basic {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read().decode()
        return json.loads(raw) if raw else {}


def to_ms(ts: str) -> int:
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return int(dt.timestamp() * 1000)


def to_s(ts: str) -> float:
    # OpenMetrics timestamps are UNIX SECONDS (millis land in year ~57000).
    dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return dt.timestamp()


def esc(v: str) -> str:
    return v.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def build_openmetrics() -> Path:
    WORK.mkdir(parents=True, exist_ok=True)
    out = WORK / "render_queue.openmetrics"
    rows = list(csv.DictReader(open(TELEMETRY / "render_queue_metrics.csv", encoding="utf-8")))
    with open(out, "w", encoding="utf-8", newline="\n") as fh:  # LF only: promtool rejects CRLF
        fh.write("# HELP cineops_render_queue_latency_seconds Render queue latency per job (synthetic demo).\n")
        fh.write("# TYPE cineops_render_queue_latency_seconds gauge\n")
        fh.write("# UNIT cineops_render_queue_latency_seconds seconds\n")
        for r in rows:
            labels = (
                f'production="{esc(r["production"])}",job_id="{esc(r["job_id"])}",'
                f'shot_id="{esc(r["shot_id"])}",status="{esc(r["status"])}",vendor="{esc(r["vendor"])}"'
            )
            # Canonical demo metric name (== scripts/seed-grafana.ts __name__).
            fh.write(f"cineops_render_queue_latency_seconds{{{labels}}} {r['queue_latency_sec']} {to_s(r['ts'])}\n")
        fh.write("# EOF\n")
    print(f"openmetrics: {len(rows)} samples -> {out}", flush=True)
    return out


def run_prometheus(om: Path) -> None:
    # No Windows bind mounts (Docker Desktop file sharing is unreliable here):
    # ship the input via `docker cp` into named volumes (vol-in: input,
    # vol-out: blocks only, later mounted as the Prometheus data dir).
    sh(["docker", "rm", "-f", "cineops-prom"])
    sh(["docker", "volume", "create", "cineops-prom-in"])
    sh(["docker", "volume", "create", "cineops-prom-out"])
    sh(["docker", "create", "--name", "cineops-promcp", "-v", "cineops-prom-in:/in",
        "prom/prometheus:v3.5.0"])
    try:
        sh(["docker", "cp", str(om), "cineops-promcp:/in/in.om"])
    finally:
        sh(["docker", "rm", "cineops-promcp"])
    out = sh(["docker", "run", "--rm", "--user", "root", "--entrypoint", "promtool",
              "-v", "cineops-prom-in:/in:ro", "-v", "cineops-prom-out:/out",
              "prom/prometheus:v3.5.0", "tsdb", "create-blocks-from", "openmetrics",
              "/in/in.om", "/out"])
    print("promtool:", [l for l in out.splitlines() if "block" in l.lower()][-1:], flush=True)
    sh(["docker", "rm", "-f", "cineops-prom"])
    sh(["docker", "run", "-d", "--name", "cineops-prom", "--network", "cineops-e2e",
        "--user", "root",  # local E2E only: named volume is root-owned
        "-p", "127.0.0.1:9090:9090", "-v", "cineops-prom-out:/prometheus",
        "prom/prometheus:v3.5.0",
        "--config.file=/etc/prometheus/prometheus.yml",
        "--storage.tsdb.path=/prometheus", "--storage.tsdb.retention.time=90d",
        "--query.lookback-delta=30d", "--web.enable-lifecycle"])
    for _ in range(40):
        try:
            urllib.request.urlopen(PROM + "/-/healthy", timeout=5).read()
            print("prometheus: healthy", flush=True)
            return
        except Exception:
            time.sleep(3)
    raise RuntimeError("prometheus did not become healthy")


def run_loki() -> None:
    sh(["docker", "rm", "-f", "cineops-loki"])
    sh(["docker", "run", "-d", "--name", "cineops-loki", "--network", "cineops-e2e",
        "-p", "127.0.0.1:3100:3100", "grafana/loki:3.4.1",
        "-config.file=/etc/loki/local-config.yaml"])
    for _ in range(40):
        try:
            urllib.request.urlopen(LOKI + "/ready", timeout=5).read()
            print("loki: ready", flush=True)
            return
        except Exception:
            time.sleep(3)
    raise RuntimeError("loki did not become ready")


def push_logs() -> None:
    import time as _time

    now_ms = int(_time.time() * 1000)
    streams: dict[str, list] = {}
    dropped = 0
    for line in open(TELEMETRY / "failed_jobs.jsonl", encoding="utf-8"):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        ts_ms = to_ms(row["ts"])
        if ts_ms > now_ms:
            dropped += 1  # Loki rejects future timestamps; demo window is all past anyway
            continue
        key = json.dumps({"production": "NEON HOLLOW", "shot_id": row.get("shot_id", "?"),
                          "level": row.get("level", "?")}, sort_keys=True)
        ts_ns = str(ts_ms * 1_000_000)
        streams.setdefault(key, []).append([ts_ns, line])
    body = {"streams": [{"stream": json.loads(k), "values": sorted(v)} for k, v in streams.items()]}
    req = urllib.request.Request(LOKI + "/loki/api/v1/push", data=json.dumps(body).encode(),
                                 method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        assert r.status in (200, 204), f"loki push: {r.status}"
    print(f"loki: pushed {sum(len(v) for v in streams.values())} lines in {len(streams)} streams (dropped {dropped} future)", flush=True)


def provision_datasources() -> None:
    existing = {d["name"]: d for d in gapi("GET", "/api/datasources")}
    want = {
        "cineops-prom": {"type": "prometheus", "access": "proxy", "url": "http://cineops-prom:9090"},
        "cineops-loki": {"type": "loki", "access": "proxy", "url": "http://cineops-loki:3100"},
    }
    for name, spec in want.items():
        if name in existing:
            print(f"datasource {name}: present", flush=True)
            continue
        gapi("POST", "/api/datasources", {"name": name, **spec})
        print(f"datasource {name}: created", flush=True)


def main() -> None:
    om = build_openmetrics()
    run_prometheus(om)
    run_loki()
    push_logs()
    provision_datasources()
    print("LOCAL-TELEMETRY-READY", flush=True)


if __name__ == "__main__":
    sys.exit(main())
