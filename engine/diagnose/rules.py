# CineOps Guardian — deterministic diagnosis rules (DP-DIAG §3.1).
# Pure correlation: no MCP, no BigQuery, no LLM. Single owner of
# RuleContext, DIAGNOSTIC_RULES, build_rule_context, correlate, at_risk_hours.
from __future__ import annotations
import json
from dataclasses import dataclass, field
from typing import Any, Callable

from engine.schema.domain import (
    DeliveryCommitment,
    GrafanaEvidence,
    IncidentFinding,
    ProductionShot,
)
from engine.runtime.guard import guarded
from src.resilience.degraded import is_degraded_result
from engine.runtime.guard import unwrap

LATENCY_BREACH_SECONDS: float = 120.0
LATENCY_MIN_CONSECUTIVE: int = 5
FAILED_RUN_THRESHOLD: int = 3
AT_RISK_PER_SHOT_HOURS: float = 4.0
AT_RISK_PER_DEPENDANT_HOURS: float = 1.5
AT_RISK_CAP_HOURS: float = 48.0

_SHOT_INDEX: list[ProductionShot] = []


@dataclass
class RuleContext:
    shot: ProductionShot
    commitments_for_shot: list[DeliveryCommitment] = field(default_factory=list)
    metrics_rows: list[dict] = field(default_factory=list)
    log_rows: list[dict] = field(default_factory=list)
    alert_rows: list[dict] = field(default_factory=list)
    incident_rows: list[dict] = field(default_factory=list)
    trend: list[dict] = field(default_factory=list)
    evidence_ids: list[str] = field(default_factory=list)
    incident_window: dict = field(default_factory=dict)


def _is_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _num(v: Any) -> float | None:
    if _is_number(v):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v.strip())
        except (ValueError, TypeError):
            return None
    return None


def _expand_prom_series(entry: dict) -> list[dict]:
    """One Prometheus series -> flat row(s): labels on top, samples kept."""
    base = dict(entry.get("metric") or {})
    if not isinstance(base, dict):
        base = {}
    if "values" in entry and isinstance(entry["values"], list):
        return [{**base, "values": list(entry["values"])}]
    if "value" in entry:
        return [{**base, "value": entry["value"]}]
    return [{**base}] if base else []


def _expand_loki_entry(entry: dict) -> list[dict]:
    """One Loki stream entry -> flat row: labels on top, JSON lines parsed."""
    base = dict(entry.get("labels") or {})
    if not isinstance(base, dict):
        base = {}
    line = entry.get("line")
    if isinstance(line, str):
        s = line.strip()
        if s.startswith("{"):
            try:
                parsed = json.loads(s)
            except (json.JSONDecodeError, ValueError):
                parsed = None
            if isinstance(parsed, dict):
                return [{**base, **parsed, "line": line}]
        return [{**base, "line": line}]
    if isinstance(line, dict):
        return [{**base, **line}]
    return [{**base}] if base else []


def _flatten_evidence_rows(rows: list) -> list[dict]:
    """Unwrap MCP envelope payloads into flat per-series/per-entry dicts.

    query_prometheus returns {"data": [{metric, values}, ...]} (range) or
    {"data": {"result": [...]}}; query_loki_logs returns
    {"data": [{timestamp, line, labels}, ...]} with JSON lines. Rules below
    only understand flat rows, so expand here — once, centrally.
    """
    out: list[dict] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        data = r.get("data")
        items: list | None = None
        if isinstance(data, list):
            items = data
        elif isinstance(data, dict) and isinstance(data.get("result"), list):
            items = data["result"]
        if items is None:
            out.append(r)
            continue
        for e in items:
            if not isinstance(e, dict):
                continue
            if "metric" in e or "values" in e or "value" in e:
                out.extend(_expand_prom_series(e))
            elif "line" in e or "labels" in e:
                out.extend(_expand_loki_entry(e))
            else:
                out.append(e)
    return out


def row_matches_shot(row: dict, shot: ProductionShot) -> bool:
    try:
        if str(row.get("shot_id")) == shot.shot_id:
            return True
    except Exception:
        pass
    try:
        rjob = row.get("render_job_id")
        if rjob is not None and shot.render_job_id is not None and str(rjob) == str(shot.render_job_id):
            return True
    except Exception:
        pass
    try:
        for v in row.values():
            if isinstance(v, str) and v in (shot.shot_id, str(shot.render_job_id) if shot.render_job_id else "\x00"):
                return True
    except Exception:
        pass
    return False


def _has_match_keys(row: dict) -> bool:
    if not isinstance(row, dict):
        return False
    if "shot_id" in row or "render_job_id" in row:
        return True
    return False


def build_rule_context(shot, commitments_for_shot, evidence, trend, incident_window) -> RuleContext:
    """Build the RuleContext for one shot from normalised evidence. Keys: shot, commitments_for_shot, metrics_rows, log_rows, alert_rows, incident_rows, trend, evidence_ids, incident_window."""
    metrics_rows: list[dict] = []
    log_rows: list[dict] = []
    alert_rows: list[dict] = []
    incident_rows: list[dict] = []
    evidence_ids: list[str] = []
    for e in evidence or []:
        if is_degraded_result(e):
            continue
        kind = getattr(e, "kind", None)
        rows = _flatten_evidence_rows(list(getattr(e, "rows", None) or []))
        contributed = False
        if kind == "metrics":
            for r in rows:
                if not isinstance(r, dict):
                    continue
                if row_matches_shot(r, shot) or not _has_match_keys(r):
                    metrics_rows.append(r)
                    contributed = True
        elif kind == "logs":
            for r in rows:
                if not isinstance(r, dict):
                    continue
                if row_matches_shot(r, shot):
                    log_rows.append(r)
                    contributed = True
        elif kind == "alerts":
            for r in rows:
                if isinstance(r, dict):
                    alert_rows.append(r)
                    contributed = True
        elif kind == "incidents":
            for r in rows:
                if isinstance(r, dict):
                    incident_rows.append(r)
                    contributed = True
        else:
            continue
        if contributed:
            evidence_ids.append(getattr(e, "evidence_id", ""))
    evidence_ids = sorted({eid for eid in evidence_ids if eid})
    return RuleContext(
        shot=shot,
        commitments_for_shot=list(commitments_for_shot or []),
        metrics_rows=metrics_rows,
        log_rows=log_rows,
        alert_rows=alert_rows,
        incident_rows=incident_rows,
        trend=list(trend or []),
        evidence_ids=evidence_ids,
        incident_window=dict(incident_window or {}),
    )


def _fail_count(ctx: RuleContext) -> int:
    n = 0
    for r in ctx.log_rows:
        if not isinstance(r, dict):
            continue
        line = r.get("line", r.get("msg"))
        if not isinstance(line, str):
            continue
        if "fail" in line.lower() and row_matches_shot(r, ctx.shot):
            n += 1
    return n


def _queue_stats(ctx: RuleContext) -> tuple[int, float]:
    vals: list[float] = []
    for r in ctx.metrics_rows:
        if not isinstance(r, dict):
            continue
        if "values" in r and isinstance(r["values"], list):
            for p in r["values"]:
                if isinstance(p, (list, tuple)) and len(p) == 2:
                    n = _num(p[1])
                    if n is not None:
                        vals.append(n)
            continue
        v = r.get("value")
        if isinstance(v, (list, tuple)) and len(v) == 2:
            n = _num(v[1])
            if n is not None:
                vals.append(n)
            continue
        if _is_number(v):
            vals.append(float(v))
    consec = 0
    best = 0
    cur = 0
    for v in vals:
        if v > LATENCY_BREACH_SECONDS:
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    consec = best
    max_v = max(vals) if vals else 0.0
    return consec, max_v


def _dependants(shot_id: str) -> list[str]:
    return sorted(o.shot_id for o in _SHOT_INDEX if shot_id in list(o.dependency_shot_ids or []) and o.shot_id != shot_id)


def _pred_queue(ctx: RuleContext) -> tuple[bool, dict]:
    consec, max_v = _queue_stats(ctx)
    return (consec >= LATENCY_MIN_CONSECUTIVE, {"consec": consec, "max_v": max_v})


def _pred_failrun(ctx: RuleContext) -> tuple[bool, dict]:
    fails = _fail_count(ctx)
    return (fails >= FAILED_RUN_THRESHOLD, {"fails": fails})


def _pred_fanout(ctx: RuleContext) -> tuple[bool, dict]:
    ok, sub = _pred_failrun(ctx)
    if not ok:
        return (False, sub)
    deps = _dependants(ctx.shot.shot_id)
    if not deps:
        return (False, {**sub, "n_dep": 0, "dep_list": ""})
    return (True, {**sub, "n_dep": len(deps), "dep_list": ", ".join(deps)})


def _pred_alert(ctx: RuleContext) -> tuple[bool, dict]:
    for r in ctx.alert_rows:
        if not isinstance(r, dict):
            continue
        state = r.get("state")
        if not isinstance(state, str) or state.lower() not in ("firing", "alerting", "pending"):
            continue
        if r.get("vendor") == ctx.shot.vfx_vendor or r.get("shot_id") == ctx.shot.shot_id:
            return (True, {"alert_name": str(r.get("name", "?")), "alert_state": str(state)})
    return (False, {})


def _pred_incident(ctx: RuleContext) -> tuple[bool, dict]:
    for r in ctx.incident_rows:
        if not isinstance(r, dict):
            continue
        state = r.get("state", r.get("status"))
        if not isinstance(state, str) or state.lower() not in ("open", "firing", "active", "investigating"):
            continue
        title = str(r.get("title", r.get("name", "?")))
        prod = r.get("production", None)
        if prod is None or prod == ctx.shot.production or str(ctx.shot.production) in title:
            return (True, {"incident_title": title, "incident_state": str(state)})
    return (False, {})


def _pred_commit(ctx: RuleContext) -> tuple[bool, dict]:
    window_from = ctx.incident_window.get("from")
    window_to = ctx.incident_window.get("to")
    if not isinstance(window_from, str) or not isinstance(window_to, str):
        return (False, {})
    if ctx.shot.status in ("approved", "delivered"):
        return (False, {})
    for c in ctx.commitments_for_shot:
        due = getattr(c, "due_at", None)
        if isinstance(due, str) and window_from <= due <= window_to:
            return (True, {"commitment_id": c.commitment_id, "due_at": due})
    return (False, {})


def _pred_trend(ctx: RuleContext) -> tuple[bool, dict]:
    try:
        if not isinstance(ctx.trend, list) or len(ctx.trend) < 2:
            return (False, {})
        first, last = ctx.trend[0], ctx.trend[-1]
        if not isinstance(first, dict) or not isinstance(last, dict):
            return (False, {})
        ff, lf = first.get("failed_jobs"), last.get("failed_jobs")
        fp, lp = first.get("p95_latency_sec"), last.get("p95_latency_sec")
        if not all(_is_number(v) for v in (ff, lf, fp, lp)):
            return (False, {})
        if lf > ff and lp > fp:  # type: ignore[operator]
            return (True, {"first_f": ff, "last_f": lf, "first_p": float(fp), "last_p": float(lp)})  # type: ignore[arg-type]
        return (False, {})
    except Exception:
        return (False, {})


def _pred_ok(ctx: RuleContext) -> tuple[bool, dict]:
    return (ctx.shot.status in ("approved", "delivered"), {})


DIAGNOSTIC_RULES: list = [
    ("R-QUEUE", _pred_queue, "blocked", "Queue latency {consec}x > 120.0s for shot {shot_id} (vendor {vendor}, max {max_v:.1f}s)"),
    ("R-FAILRUN", _pred_failrun, "high", "Found {fails} failed render-job log lines for shot {shot_id} (job {render_job_id})"),
    ("R-FANOUT", _pred_fanout, "blocked", "Shot {shot_id} failed and blocks {n_dep} downstream shot(s): {dep_list}"),
    ("R-ALERT", _pred_alert, "high", "Alert {alert_name} is {alert_state} for vendor {vendor} (shot {shot_id})"),
    ("R-INCIDENT", _pred_incident, "blocked", "Open incident {incident_title} ({incident_state}) touches production {production}"),
    ("R-COMMIT", _pred_commit, "medium", "Commitment {commitment_id} due {due_at} covers unapproved shot {shot_id} (status {status})"),
    ("R-TREND", _pred_trend, "medium", "Worsening 7d trend: failed_jobs {first_f}→{last_f}, p95 {first_p:.1f}s→{last_p:.1f}s"),
    ("R-OK", _pred_ok, "ok", "Shot {shot_id} healthy (status {status}, vendor {vendor})"),
]


def _base_subs(ctx: RuleContext) -> dict:
    return {
        "shot_id": ctx.shot.shot_id,
        "vendor": ctx.shot.vfx_vendor or "?",
        "render_job_id": ctx.shot.render_job_id or "?",
        "status": ctx.shot.status,
        "production": ctx.shot.production,
        "consec": "?",
        "max_v": "?",
        "fails": "?",
        "n_dep": "?",
        "dep_list": "?",
        "alert_name": "?",
        "alert_state": "?",
        "incident_title": "?",
        "incident_state": "?",
        "commitment_id": "?",
        "due_at": "?",
        "first_f": "?",
        "last_f": "?",
        "first_p": "?",
        "last_p": "?",
    }


def at_risk_hours(ctx: RuleContext, level: str) -> float:
    base = {"blocked": 16.0, "high": 8.0, "medium": 4.0, "low": 2.0, "ok": 0.0}.get(level, 0.0)
    if level == "ok":
        return 0.0
    n_fails = _fail_count(ctx)
    n_dep = len(_dependants(ctx.shot.shot_id))
    hours = base + AT_RISK_PER_SHOT_HOURS * min(n_fails, 6) + AT_RISK_PER_DEPENDANT_HOURS * min(n_dep, 8)
    return round(min(hours, AT_RISK_CAP_HOURS), 1)


def correlate(shots, commitments, evidence, trend) -> list[IncidentFinding]:
    global _SHOT_INDEX
    reasons_degraded: list[str] = []
    trend_list = unwrap(trend, [], reasons_degraded)
    if not isinstance(trend_list, list):
        trend_list = []
    try:
        with open("engine/rag/corpus/CORPUS.json", "r", encoding="utf-8") as fh:
            incident_window = json.load(fh).get("incident_window", {}) or {}
    except Exception:
        incident_window = {}
    _SHOT_INDEX = list(shots or [])
    ordered = sorted(list(shots or []), key=lambda s: s.shot_id)
    comms_sorted = sorted(list(commitments or []), key=lambda c: c.commitment_id)
    clean_evidence = [e for e in (evidence or []) if not is_degraded_result(e)]
    findings: list[IncidentFinding] = []
    for shot in ordered:
        cfs = [c for c in comms_sorted if shot.shot_id in list(c.covers_shot_ids or [])]
        ctx = build_rule_context(shot, cfs, clean_evidence, trend_list, incident_window)
        for rule_id, pred, level, tmpl in DIAGNOSTIC_RULES:
            try:
                matched, subs = pred(ctx)
            except Exception:
                matched, subs = False, {}
            if matched:
                merged = _base_subs(ctx)
                merged.update({k: v for k, v in (subs or {}).items() if v is not None})
                try:
                    reason = tmpl.format(**merged)
                except Exception:
                    reason = tmpl
                findings.append(
                    IncidentFinding(
                        finding_id=f"f-{shot.shot_id}",
                        shot_id=shot.shot_id,
                        level=level,  # type: ignore[arg-type]
                        rule_ids=[rule_id],
                        reasons=[reason],
                        evidence_ids=list(ctx.evidence_ids),
                        commitment_ids=sorted(c.commitment_id for c in cfs),
                        at_risk_hours=at_risk_hours(ctx, level),
                    )
                )
                break
    return findings
