# CineOps Guardian — remediation proposal (DP-DIAG §3.2).
# Deterministic actions + one rationale prose call. Single owner of
# ANNOTATION_TEMPLATE, propose_remediation, hours_saved, apply_reprioritization.
from __future__ import annotations
import json
from src.resilience.degraded import is_degraded_result

from engine.schema.domain import GrafanaEvidence, IncidentFinding, ProductionShot, RemediationAction
from engine.providers.gemini import generate_text
from engine.runtime.budget import fit_prompt
from engine.runtime.guard import guarded, unwrap

ANNOTATION_TEMPLATE: str = (
    "[{level}] {shot_id} ({production}) — {rule_id}: {reason} "
    "| evidence={evidence_ids} commitments={commitment_ids} at_risk_hours={at_risk_hours:.1f}"
)

HOURS_SAVED_PER_REPRIORITIZED_SHOT: float = 2.5
HOURS_SAVED_PER_APPROVAL_CLEARED: float = 1.0

LEVEL_RANK: dict[str, int] = {"ok": 0, "low": 1, "medium": 2, "high": 3, "blocked": 4}


def hours_saved(actions, findings) -> float:
    n_rep = sum(1 for a in actions if getattr(a, "kind", None) == "reprioritize")
    n_notes = sum(1 for a in actions if getattr(a, "kind", None) in ("annotate", "incident_note"))
    n_blocked = sum(1 for f in findings if getattr(f, "level", None) == "blocked")
    total = (
        HOURS_SAVED_PER_REPRIORITIZED_SHOT * n_rep
        + HOURS_SAVED_PER_APPROVAL_CLEARED * min(n_notes, 2)
        + 4.0 * min(n_blocked, 4)
    )
    return round(min(total, 60.0), 1)


def _dashboard_target() -> tuple[str, int]:
    try:
        with open("engine/rag/corpus/CORPUS.json", "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return str(data.get("dashboard_uid", "cineops-render-queue")), int(data.get("panel_id", 1))
    except Exception:
        return "cineops-render-queue", 1


@guarded("diag-propose-remediation", provider="google")
def propose_remediation(findings, shots, evidence, *, severity_floor: str = "low") -> list[RemediationAction]:
    floor = severity_floor if severity_floor in ("low", "medium", "high") else "low"
    kept = [f for f in findings if getattr(f, "level", None) in LEVEL_RANK and LEVEL_RANK[f.level] >= LEVEL_RANK[floor]]
    ordered = sorted(kept, key=lambda f: (-LEVEL_RANK[f.level], -float(f.at_risk_hours or 0.0), f.shot_id or ""))
    if not ordered:
        return []
    shot_by_id = {s.shot_id: s for s in (shots or [])}
    uid, panel = _dashboard_target()
    actions: list[RemediationAction] = []
    for i, f in enumerate(ordered):
        new_priority = max(1, 10 - LEVEL_RANK[f.level] * 2 - (0 if i > 0 else 1))
        shot = shot_by_id.get(f.shot_id or "")
        if shot is not None and shot.priority != new_priority:
            actions.append(
                RemediationAction(
                    action_id=f"a-{f.finding_id}-reprioritize",
                    finding_id=f.finding_id,
                    kind="reprioritize",
                    target=f.shot_id or "",
                    new_priority=new_priority,
                    rationale="",
                    hours_saved=0.0,
                    requires_approval=False,
                )
            )
        if i == 0:
            rule_id = "+".join(f.rule_ids) if f.rule_ids else "?"
            reason = f.reasons[0] if f.reasons else "?"
            text = ANNOTATION_TEMPLATE.format(
                level=f.level,
                shot_id=f.shot_id or "?",
                production=(shot.production if shot is not None else "?"),
                rule_id=rule_id,
                reason=reason,
                evidence_ids=",".join(f.evidence_ids) if f.evidence_ids else "none",
                commitment_ids=",".join(f.commitment_ids) if f.commitment_ids else "none",
                at_risk_hours=float(f.at_risk_hours or 0.0),
            )
            actions.append(
                RemediationAction(
                    action_id=f"a-{f.finding_id}-annotate",
                    finding_id=f.finding_id,
                    kind="annotate",
                    target=f"{uid}/{panel}",
                    annotation_text=text,
                    dashboard_uid=uid,
                    panel_id=panel,
                    time_ms=None,
                    rationale="",
                    hours_saved=0.0,
                    requires_approval=True,
                )
            )
            actions.append(
                RemediationAction(
                    action_id=f"a-{f.finding_id}-note",
                    finding_id=f.finding_id,
                    kind="incident_note",
                    target=f.shot_id or "",
                    annotation_text=text,
                    dashboard_uid=uid,
                    panel_id=panel,
                    time_ms=None,
                    rationale="",
                    hours_saved=0.0,
                    requires_approval=True,
                )
            )
    top = ordered[0]
    finding_block = f"{top.finding_id} {top.shot_id} {top.level} {top.rule_ids} {top.reasons} at_risk={top.at_risk_hours}"
    actions_block = "; ".join(f"{a.kind}:{a.target}:p{a.new_priority}" for a in actions)
    try:
        template = open("engine/prompts/remediate.md", "r", encoding="utf-8").read()
        prompt = template.format(finding_block=finding_block, actions_block=actions_block)
    except Exception:
        prompt = f"Finding: {finding_block}. Actions: {actions_block}."
    msgs = [
        {"role": "system", "content": "You write prose only."},
        {"role": "user", "content": prompt},
    ]
    fitted, _status = fit_prompt(msgs)
    last_content = fitted[-1]["content"] if fitted else prompt
    out = generate_text(last_content, system="You write prose only.", label="diag-rationale")
    reasons: list[str] = []
    text = unwrap(out, "", reasons)
    if is_degraded_result(out) or not text:
        text = " | ".join(top.reasons) if top.reasons else ""
    text = str(text)[:2000]
    total = hours_saved(actions, ordered)
    return [
        a.model_copy(update={"rationale": text, "hours_saved": total}) for a in actions
    ]


def apply_reprioritization(shots, actions) -> list[ProductionShot]:
    pri: dict[str, int] = {}
    for a in actions or []:
        if getattr(a, "kind", None) == "reprioritize" and getattr(a, "new_priority", None) is not None:
            pri[str(a.target)] = int(a.new_priority)  # type: ignore[arg-type]
    return [
        s.model_copy(update={"priority": pri[s.shot_id]}) if s.shot_id in pri else s
        for s in sorted(list(shots or []), key=lambda s: s.shot_id)
    ]
