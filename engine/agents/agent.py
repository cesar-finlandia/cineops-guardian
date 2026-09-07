# CineOps Guardian — deterministic 8-step google-adk agent (DP-AGENT §3).
# The model never chooses steps: run_diagnosis executes the fixed STEP_IDS
# sequence. Gemini plans only the Grafana query contents (QueryPlan.steps).
from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

from google.adk.agents import Agent

from engine.providers.gemini import build_adk_model, generate_structured, generate_text
from engine.schema.domain import (
    GrafanaEvidence,
    IncidentFinding,
    QueryPlan,
    RemediationAction,
    RunRequest,
    RunResult,
    WriteReceipt,
    load_schema,
    STEP_IDS,
    MAX_PLAN_STEPS,
)
from engine.mcp.grafana_mcp import (
    mcp_call,
    mcp_write_annotation,
    mcp_write_incident_note,
    resolve_tool,
)
from engine.runtime.guard import guarded
from src.resilience.degraded import is_degraded_result
from src.resilience.validate import validate

PROMPT_DIR: Path = Path(__file__).resolve().parent.parent / "prompts"
TOOL_SPECS: list[dict] = [
    {"name": "tool_load_context", "description": "Load shots + commitments for a production. Returns {\"shots\": [...], \"commitments\": [...]}.", "parameters": {"type": "object", "properties": {"question": {"type": "string"}, "production": {"type": "string"}}}},
    {"name": "tool_plan_queries", "description": "Plan Grafana work as a validated QueryPlan dict (clamped to MAX_PLAN_STEPS).", "parameters": {"type": "object", "properties": {"question": {"type": "string"}, "window_from": {"type": "string"}, "window_to": {"type": "string"}}}},
    {"name": "tool_query_grafana", "description": "Execute a validated QueryPlan via MCP only. Returns {\"evidence\": [...]}.", "parameters": {"type": "object", "properties": {"plan": {"type": "object"}}}},
    {"name": "tool_correlate", "description": "Correlate evidence to findings + remediation actions. Returns {\"findings\": [...], \"actions\": [...]}.", "parameters": {"type": "object", "properties": {"evidence": {"type": "array"}}}},
    {"name": "tool_summarize", "description": "Render the run summary markdown. Returns {\"summary_markdown\": str}.", "parameters": {"type": "object", "properties": {"run": {"type": "object"}}}},
]
_AGENT: Agent | None = None

_FALLBACK_STEPS = [
    {"step_no": 1, "kind": "dashboards", "tool_hint": "search_dashboards", "args": {"query": "cineops"}, "why": "locate render-queue dashboard"},
    # Canonical demo metric (scripts/seed-grafana.ts + local E2E seeder agree;
    # the dashboard histogram panel is aspirational). LogQL valid on both
    # stacks (production label exists in Cloud and local Loki).
    {"step_no": 2, "kind": "metrics", "tool_hint": "query_prometheus", "args": {"query": "cineops_render_queue_latency_seconds"}, "why": "render latency in window"},
    {"step_no": 3, "kind": "logs", "tool_hint": "query_loki_logs", "args": {"query": "{production=\"PALS\"} |= \"failed\""}, "why": "failed jobs in window"},
]
_VALID_KINDS = ("metrics", "logs", "traces", "dashboards", "alerts", "incidents")


def _read_prompt(name: str) -> str:
    return (PROMPT_DIR / name).read_text(encoding="utf-8")


def tool_load_context(question: str, production: str) -> dict:
    """Load shots + commitments for a production. Returns {"shots": [...], "commitments": [...]}."""
    from concurrent.futures import ThreadPoolExecutor

    from engine.ingest.shot_list import extract_shot_list
    from engine.ingest.memo import extract_commitments
    from engine.ingest.normalize import normalize_context

    shots = extract_shot_list("engine/rag/corpus/shots/shot_list.csv", production=production)
    memos_dir = Path("engine/rag/corpus/memos")
    pdfs = sorted(p for p in memos_dir.glob("*.pdf") if p.name != "01-vfx-delivery-memo.pdf")
    # legacy alias of memo 01 skipped to avoid double counting (see below)

    def _one(pdf: Path) -> list:
        try:
            return extract_commitments(str(pdf), production=production)
        except Exception:
            return []

    # NFR-05: multimodal extraction is ~20 s per memo on Vertex; sequential
    # reads blow the 90 s run budget structurally. ex.map preserves pdf order,
    # so output stays deterministic; per-file failures degrade to [] (same as
    # an empty extraction today).
    commitments = []
    if pdfs:
        with ThreadPoolExecutor(max_workers=min(6, len(pdfs))) as ex:
            for comms in ex.map(_one, pdfs):
                commitments.extend(comms)
    shots, commitments = normalize_context(shots, commitments)
    return {"shots": [s.model_dump() for s in shots], "commitments": [c.model_dump() for c in commitments]}


def _fallback_plan(question: str, window_from: str, window_to: str) -> dict:
    import copy

    return {
        "plan_id": "plan-fallback",
        "question": question,
        "window_from": window_from,
        "window_to": window_to,
        "steps": copy.deepcopy(_FALLBACK_STEPS),
    }


def _inventory_block() -> str:
    """Known-good query inventory for the planner (E2E F16).

    Gemini invents label/metric names when unaided (e.g. job="dailies-scheduler"),
    which yields empty evidence. Ground it with the demo corpus facts: the
    canonical metric both seeders write, the dashboard UID, and a valid LogQL
    selector. Dashboard panel exprs are included verbatim as examples.
    """
    lines = [
        '- metric: cineops_render_queue_latency_seconds (labels: production, shot_id, vendor, status)',
        '- logs selector: {production="PALS"} with filter |= "failed"',
        '- prefer simple per-shot selectors (plain metric or LogQL stream); avoid histogram_quantile/aggregations unless bucket series exist — aggregations collapse the per-shot attribution the rules need',
    ]
    try:
        data = json.loads(Path("engine/rag/corpus/CORPUS.json").read_text(encoding="utf-8"))
        lines.append(f"- dashboard: uid={data.get('dashboard_uid', 'cineops-render-queue')} production={data.get('production', 'PALS')}")
    except Exception:
        lines.append("- dashboard: uid=cineops-render-queue production=PALS")
    try:
        dash = json.loads(Path("grafana/dashboard.json").read_text(encoding="utf-8"))
        for p in dash.get("panels", []) or []:
            for t in (p.get("targets", None) or []) or []:
                expr = t.get("expr")
                if isinstance(expr, str) and expr:
                    lines.append(f"- panel example ({p.get('title', '?')}): {expr}")
    except Exception:
        pass
    return "\n".join(lines)


def _clamp_plan(out: dict) -> dict | None:
    # Sanitize-then-validate (E2E F16): the model adds step-level window keys
    # and bare-string args against the strict schema. Drop unknown step keys
    # and salvage string args into {"query": ...} instead of discarding an
    # otherwise good plan to the fallback.
    _STEP_KEYS = ("step_no", "kind", "tool_hint", "args", "why")
    try:
        steps = list(out.get("steps", []) or [])[:MAX_PLAN_STEPS]
        kept = []
        for s in steps:
            if not isinstance(s, dict):
                continue
            s = {k: s[k] for k in _STEP_KEYS if k in s}
            if s.get("kind") not in _VALID_KINDS or "args" not in s:
                continue
            if isinstance(s["args"], str):
                s["args"] = {"query": s["args"]}
            if not isinstance(s.get("args"), dict):
                continue
            kept.append(s)
        for i, s in enumerate(kept):
            s["step_no"] = i + 1
        cand = dict(out)
        cand["steps"] = kept
        if not kept:
            return None
        r = validate(load_schema("query-plan"), cand)
        if r["valid"] is True:
            return cand
        return None
    except Exception:
        return None


def tool_plan_queries(question: str, window_from: str, window_to: str) -> dict:
    """Plan Grafana work as a validated QueryPlan dict (clamped to MAX_PLAN_STEPS)."""
    template = _read_prompt("plan_queries.md")
    system = _read_prompt("system.md")
    prompt = template.replace("{{question}}", question).replace("{{window_from}}", window_from).replace("{{window_to}}", window_to).replace("{{inventory}}", _inventory_block())
    out = generate_structured(prompt, load_schema("query-plan"), system=system, label="agent-plan-queries")
    if is_degraded_result(out):
        return {**_fallback_plan(question, window_from, window_to), "_degraded": "plan-degraded"}
    clamped = _clamp_plan(out)
    if clamped is None:
        return {**_fallback_plan(question, window_from, window_to), "_degraded": "plan-degraded"}
    return clamped


def tool_query_grafana(plan: dict) -> dict:
    """Execute a validated QueryPlan via MCP only. Returns {"evidence": [...]}."""
    evidence: list[dict] = []
    reasons: list[str] = []
    for step in plan.get("steps", []) or []:
        kind = step.get("kind")
        tool = resolve_tool(kind)
        if tool is None:
            reasons.append(f"no-tool:{kind}")
            continue
        ev = mcp_call(tool, dict(step.get("args", {}) or {}), kind=kind)
        if is_degraded_result(ev):
            reasons.append(str(ev.get("reason", "mcp-degraded")))
            continue
        evidence.append(ev.model_dump())
    out: dict = {"evidence": evidence}
    if reasons:
        out["_degraded"] = reasons
    return out


def tool_correlate(evidence: list[dict]) -> dict:
    """Correlate evidence to findings + remediation actions. Returns {"findings": [...], "actions": [...]}."""
    from engine.diagnose.rules import correlate
    from engine.diagnose.remediate import propose_remediation

    ev_objs = []
    for e in evidence or []:
        try:
            ev_objs.append(GrafanaEvidence(**e))
        except Exception:
            continue
    ctx = tool_load_context("", "PALS")
    from engine.schema.domain import ProductionShot, DeliveryCommitment

    shots = [ProductionShot(**s) for s in ctx["shots"]]
    commitments = [DeliveryCommitment(**c) for c in ctx["commitments"]]
    try:
        from engine.bq.loader import query_trend

        trend = query_trend("PALS")
    except Exception:
        trend = []
    findings = correlate(shots, commitments, ev_objs, trend)
    actions = propose_remediation(findings, shots, ev_objs, severity_floor="low")
    if is_degraded_result(actions):
        actions = []
    return {"findings": [f.model_dump() for f in findings], "actions": [a.model_dump() for a in actions]}


def _summary_facts(run: dict) -> str:
    """Deterministic facts block for the summarizer (A8 grounding).

    The model previously received findings + totals only, so with no actions
    or receipts in context it wrote "No actions are proposed / No writes were
    applied" even when writes had succeeded. These lines are computed, not
    generated — the prompt orders the model to report them verbatim.
    """
    try:
        findings = run.get("findings", []) or []
        actions = run.get("actions", []) or []
        receipts = run.get("receipts", []) or []
        totals = run.get("totals", {}) or {}
        by_level: dict[str, int] = {}
        for f in findings:
            lv = str((f.get("level") if isinstance(f, dict) else getattr(f, "level", "?")) or "?")
            by_level[lv] = by_level.get(lv, 0) + 1
        by_kind: dict[str, int] = {}
        for a in actions:
            k = str((a.get("kind") if isinstance(a, dict) else getattr(a, "kind", "?")) or "?")
            by_kind[k] = by_kind.get(k, 0) + 1
        ok_lines = []
        for r in receipts:
            g = (lambda k, d="": (r.get(k, d) if isinstance(r, dict) else getattr(r, k, d)))
            ok_lines.append(f"- {g('action_id')}: ok={g('ok')} via {g('mcp_tool')} (path {g('path')}) link={g('grafana_link') or 'none'}")
        lines = [
            "VERIFIED RUN FACTS (report these numbers verbatim; never contradict them):",
            f"- findings: {len(findings)} {by_level}",
            f"- actions proposed: {len(actions)} {by_kind}",
            f"- write receipts: {len(receipts)}",
            *ok_lines,
            f"- totals: {totals}",
        ]
        return "\n".join(lines)
    except Exception:
        return "VERIFIED RUN FACTS unavailable (malformed run dict)."


def tool_summarize(run: dict) -> dict:
    """Render the run summary markdown. Returns {"summary_markdown": str}."""
    template = _read_prompt("summarize_run.md")
    system = _read_prompt("system.md")
    try:
        run_json = json.dumps(run, sort_keys=True, default=str)
    except Exception:
        run_json = str(run)
    facts = _summary_facts(run if isinstance(run, dict) else {})
    prompt = template.replace("{{run_json}}", run_json) + "\n\n" + facts + "\n"
    out = generate_text(prompt, system=system, label="agent-summarize")
    if is_degraded_result(out):
        reasons = out.get("reason", "degraded")
        return {"summary_markdown": f"summary unavailable (degraded: {reasons})"}
    return {"summary_markdown": str(out)}


def build_agent() -> Agent:
    global _AGENT
    if _AGENT is None:
        instruction = (PROMPT_DIR / "system.md").read_text(encoding="utf-8")
        # NOTE (DP-AGENT §5 vs google-adk 2.8.0): Agent is an alias of LlmAgent
        # (type name prints LlmAgent) and `name` must be a valid Python
        # identifier, so the hyphenated "cineops-guardian" becomes
        # "cineops_guardian". Import-and-call site is unchanged.
        _AGENT = Agent(
            model=build_adk_model(),
            name="cineops_guardian",
            instruction=instruction,
            tools=[tool_load_context, tool_plan_queries, tool_query_grafana, tool_correlate, tool_summarize],
        )
    return _AGENT


async def run_diagnosis(request: RunRequest, publish: Any = None, approval: Any = None, *, approval_gate: Any = None) -> RunResult:
    """Fixed 8-step orchestration (A1-A8). Never raises: degrades into RunResult."""
    # DP-API passes (request, publish, gate) positionally; the plan's
    # keyword-only `approval_gate` is accepted as an alias.
    gate = approval_gate if approval_gate is not None else approval
    trace_id = request.trace_id or str(uuid.uuid4())
    build_agent()  # prove the google-adk call path on every live run
    degraded_reasons: list[str] = []
    plan_degraded = False

    async def _pub(step_id: str, status: str, payload: dict, degraded: bool = False) -> None:
        if publish is None:
            return
        try:
            await publish(step_id, status, payload, degraded=degraded)
        except Exception:
            pass

    # A1 load-context. The started envelope goes out BEFORE the slow work
    # (CSV parse + up to 6 parallel Gemini memo reads, ~1 min): it is the
    # first envelope of the whole run, and the UI's row-1 spinner + reel
    # depend on it. Without this the timeline sits all-pending for a minute.
    from engine.schema.domain import ProductionShot, DeliveryCommitment

    try:
        await _pub("load-context", "started", {"corpus": request.corpus, "files": list(request.uploads or [])})
        ctx = tool_load_context(request.question, request.production)
        shots = [ProductionShot(**s) for s in ctx["shots"]]
        commitments = [DeliveryCommitment(**c) for c in ctx["commitments"]]
        await _pub("load-context", "done", {"shots": len(shots), "commitments": len(commitments)})
    except Exception as exc:
        shots, commitments = [], []
        degraded_reasons.append(f"load-context: {exc}")
        await _pub("load-context", "done", {"shots": 0, "error": str(exc)}, degraded=True)

    # A2 plan-queries.
    await _pub("plan-queries", "started", {"question": request.question})
    try:
        plan_dict = tool_plan_queries(request.question, request.window_from, request.window_to)
        if plan_dict.pop("_degraded", None):
            plan_degraded = True
            degraded_reasons.append("plan-degraded")
        plan = QueryPlan(**{k: v for k, v in plan_dict.items() if not k.startswith("_")})
        await _pub("plan-queries", "done", {"plan_id": plan.plan_id, "steps": len(plan.steps), "plan": plan.model_dump()}, degraded=plan_degraded)
    except Exception as exc:
        fb = _fallback_plan(request.question, request.window_from, request.window_to)
        plan = QueryPlan(**fb)
        degraded_reasons.append(f"plan-degraded: {exc}")
        await _pub("plan-queries", "done", {"plan_id": plan.plan_id, "steps": len(plan.steps)}, degraded=True)

    # A3 query-grafana.
    await _pub("query-grafana", "started", {"plan_id": plan.plan_id})
    try:
        q = tool_query_grafana(plan.model_dump())
        evidence = [GrafanaEvidence(**e) for e in q.get("evidence", [])]
        for r in q.get("_degraded", []) or []:
            degraded_reasons.append(str(r))
        mcp_calls = len(evidence)
        for ev in evidence:
            await _pub("query-grafana", "streaming", {"mcp_tool": ev.mcp_tool, "kind": ev.kind, "rows": ev.row_count, "took_ms": ev.took_ms})
        await _pub("query-grafana", "done", {"evidence": [e.model_dump() for e in evidence], "evidence_ids": [e.evidence_id for e in evidence], "mcp_calls": mcp_calls, "reasons": [str(r) for r in q.get("_degraded", []) or []]}, degraded=bool(q.get("_degraded")))
    except Exception as exc:
        evidence, mcp_calls = [], 0
        degraded_reasons.append(f"query-grafana: {exc}")
        await _pub("query-grafana", "done", {"evidence_ids": [], "mcp_calls": 0, "reasons": [f"query-grafana: {exc}"]}, degraded=True)

    # A4 persist-snapshot.
    try:
        from engine.bq.loader import persist_snapshot

        persist_snapshot(trace_id, evidence)
        await _pub("persist-snapshot", "done", {"rows": len(evidence), "table": "evidence_snapshots"})
    except Exception as exc:
        degraded_reasons.append(f"persist: {exc}")
        await _pub("persist-snapshot", "done", {"rows": 0, "error": str(exc)}, degraded=True)

    # A5 correlate-evidence.
    try:
        from engine.diagnose.rules import correlate
        from engine.bq.loader import query_trend

        try:
            trend_data = query_trend(request.production)
        except Exception:
            trend_data = []
        findings = correlate(shots, commitments, evidence, trend_data)
        await _pub("correlate-evidence", "done", {"findings": [f.model_dump() for f in findings], "finding_ids": [f.finding_id for f in findings]})
    except Exception as exc:
        findings = []
        degraded_reasons.append(f"correlate: {exc}")
        await _pub("correlate-evidence", "done", {"finding_ids": [], "error": str(exc)}, degraded=True)

    # A6 propose-remediation.
    try:
        from engine.diagnose.remediate import propose_remediation

        actions = propose_remediation(findings, shots, evidence, severity_floor=request.severity_floor)
        if is_degraded_result(actions):
            actions = []
            degraded_reasons.append(str(actions.get("reason", "remediation-degraded")) if isinstance(actions, dict) else "remediation-degraded")
        await _pub("propose-remediation", "done", {"actions": [a.model_dump() for a in actions], "action_ids": [a.action_id for a in actions], "hours_saved": round(sum(float(a.hours_saved or 0.0) for a in actions[:1]), 1)})
    except Exception as exc:
        actions = []
        degraded_reasons.append(f"propose-remediation: {exc}")
        await _pub("propose-remediation", "done", {"action_ids": [], "error": str(exc)}, degraded=True)

    # A7 write-back.
    receipts: list[WriteReceipt] = []
    try:
        if gate is None:
            await _pub("write-back", "started", {"awaiting_approval": False, "actions": [a.model_dump() for a in actions]})
            for a in actions:
                receipts.append(
                    WriteReceipt(action_id=a.action_id, ok=False, mcp_tool="stub-gate", path="mcp", remote_id=None, grafana_link=None, error="approval gate absent")  # type: ignore[arg-type]
                )
            await _pub("write-back", "done", {"receipts": [r.model_dump() for r in receipts], "approved": []})
        else:
            needs_approval = [a for a in actions if getattr(a, "requires_approval", False)]
            if not needs_approval:
                # Nothing to write: skip the gate entirely so the UI never
                # flashes an empty approval control that then vanishes. The
                # run continues straight to the summary with receipts == [].
                await _pub("write-back", "started", {"awaiting_approval": False, "actions": []})
                receipts = []
                try:
                    from engine.bq.loader import persist_remediation

                    persist_remediation(trace_id, receipts)
                except Exception as exc:
                    degraded_reasons.append(f"persist-remediation: {exc}")
                await _pub("write-back", "done", {"receipts": [], "approved": []})
            else:
                await _pub("write-back", "started", {"awaiting_approval": True, "actions": [a.model_dump() for a in needs_approval]})
                approved_ids = await gate.wait(trace_id, actions)
                if not approved_ids:
                    degraded_reasons.append("approval-timeout")
                by_id = {a.action_id: a for a in actions}
                for aid in approved_ids:
                    a = by_id.get(aid)
                    if a is None:
                        continue
                    if a.kind == "annotate":
                        receipts.append(mcp_write_annotation(a))
                    elif a.kind == "incident_note":
                        receipts.append(mcp_write_incident_note(a))
                    else:
                        continue
                try:
                    from engine.bq.loader import persist_remediation

                    persist_remediation(trace_id, receipts)
                except Exception as exc:
                    degraded_reasons.append(f"persist-remediation: {exc}")
                await _pub("write-back", "done", {"receipts": [r.model_dump() for r in receipts], "approved": list(approved_ids)})
    except Exception as exc:
        degraded_reasons.append(f"write-back: {exc}")
        await _pub("write-back", "done", {"receipts": [], "error": str(exc)}, degraded=True)

    # A8 summarize-run.
    revised = list(shots)
    try:
        from engine.diagnose.remediate import apply_reprioritization

        revised = apply_reprioritization(shots, [a for a in actions if a.kind == "reprioritize"])
    except Exception:
        pass
    blocked = sum(1 for f in findings if f.level == "blocked")
    high = sum(1 for f in findings if f.level == "high")
    at_risk = round(sum(float(f.at_risk_hours or 0.0) for f in findings), 1)
    saved = round(sum(float(a.hours_saved or 0.0) for a in actions[:1]), 1)
    totals = {"shots": len(shots), "blocked": blocked, "high": high, "at_risk_hours": at_risk, "hours_saved": saved, "mcp_calls": mcp_calls}
    try:
        summary_out = tool_summarize({
            "trace_id": trace_id,
            "findings": [f.model_dump() for f in findings],
            "actions": [a.model_dump() for a in actions],
            "receipts": [r.model_dump() for r in receipts],
            "totals": totals,
        })
        summary_md = summary_out.get("summary_markdown", "")
    except Exception as exc:
        summary_md = f"summary unavailable (degraded: {exc})"
        degraded_reasons.append(f"summarize: {exc}")
    result = RunResult(
        trace_id=trace_id,
        plan=plan,
        evidence=evidence,
        findings=findings,
        actions=actions,
        receipts=receipts,
        revised_shots=revised,
        totals=totals,  # type: ignore[arg-type]
        summary_markdown=summary_md,
        degraded=bool(degraded_reasons),
        degraded_reasons=degraded_reasons,
    )
    await _pub("summarize-run", "done", {"trace_id": trace_id, "summary_markdown": summary_md, "totals": totals})
    return result
