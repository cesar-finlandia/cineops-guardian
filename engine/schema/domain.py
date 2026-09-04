# CineOps Guardian — domain single source of truth (DP-SCHEMA §3.1).
# Ten pydantic models + STEP_IDS + MAX_PLAN_STEPS + load_schema.
# No behaviour: no HTTP, no MCP, no Gemini, no parsing/scoring.
from __future__ import annotations

import json
from pathlib import Path
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

Forbid = ConfigDict(extra="forbid")

ShotStatus = Literal["queued", "rendering", "failed", "review", "approved", "delivered"]
EvidenceKind = Literal["metrics", "logs", "traces", "dashboards", "alerts", "incidents"]
FindingLevel = Literal["ok", "low", "medium", "high", "blocked"]
ActionKind = Literal["reprioritize", "annotate", "incident_note"]
WritePath = Literal["mcp", "rest-fallback"]
SeverityFloor = Literal["low", "medium", "high"]
Corpus = Literal["demo", "upload"]

STEP_IDS: tuple[str, ...] = (
    "load-context",
    "plan-queries",
    "query-grafana",
    "persist-snapshot",
    "correlate-evidence",
    "propose-remediation",
    "write-back",
    "summarize-run",
)
MAX_PLAN_STEPS: int = 8


class ProductionShot(BaseModel):
    model_config = Forbid
    shot_id: str
    production: str
    episode_or_reel: str
    scene: str
    vfx_vendor: Optional[str] = None
    status: ShotStatus
    priority: int
    due_at: str  # ISO8601, e.g. 2026-09-05T17:00:00Z
    render_job_id: Optional[str] = None
    dependency_shot_ids: list[str] = Field(default_factory=list)
    synthetic: bool = False


class DeliveryCommitment(BaseModel):
    model_config = Forbid
    commitment_id: str
    source_file: str
    production: str
    deliverable: str
    covers_shot_ids: list[str] = Field(default_factory=list)
    due_at: str  # ISO8601
    owner: str
    notes: str = ""
    confidence: float = 1.0
    page_refs: list[int] = Field(default_factory=list)
    synthetic: bool = False


class QueryPlanStep(BaseModel):
    model_config = Forbid
    step_no: int
    kind: EvidenceKind
    tool_hint: str
    args: dict = Field(default_factory=dict)
    why: str


class QueryPlan(BaseModel):
    model_config = Forbid
    plan_id: str
    question: str
    window_from: str  # ISO8601
    window_to: str  # ISO8601
    steps: list[QueryPlanStep] = Field(min_length=1, max_length=MAX_PLAN_STEPS)


class GrafanaEvidence(BaseModel):
    model_config = Forbid
    evidence_id: str
    kind: EvidenceKind
    mcp_tool: str
    args: dict = Field(default_factory=dict)
    rows: list[dict] = Field(default_factory=list)
    row_count: int
    grafana_link: Optional[str] = None
    took_ms: int = 0
    degraded: bool = False
    synthetic: bool = False


class IncidentFinding(BaseModel):
    model_config = Forbid
    finding_id: str
    shot_id: Optional[str] = None
    level: FindingLevel
    rule_ids: list[str] = Field(default_factory=list)
    reasons: list[str] = Field(default_factory=list)
    evidence_ids: list[str] = Field(default_factory=list)
    commitment_ids: list[str] = Field(default_factory=list)
    at_risk_hours: float = 0.0


class RemediationAction(BaseModel):
    model_config = Forbid
    action_id: str
    finding_id: str
    kind: ActionKind
    target: str
    new_priority: Optional[int] = None
    annotation_text: Optional[str] = None
    dashboard_uid: Optional[str] = None
    panel_id: Optional[int] = None
    time_ms: Optional[int] = None
    rationale: str
    hours_saved: float = 0.0
    requires_approval: bool = True


class WriteReceipt(BaseModel):
    model_config = Forbid
    action_id: str
    ok: bool
    mcp_tool: str
    path: WritePath
    remote_id: Optional[str] = None
    grafana_link: Optional[str] = None
    error: Optional[str] = None


class RunRequest(BaseModel):
    model_config = Forbid
    question: str
    production: str
    window_from: str  # ISO8601
    window_to: str  # ISO8601
    severity_floor: SeverityFloor = "low"
    corpus: Corpus = "demo"
    uploads: list[str] = Field(default_factory=list)
    trace_id: Optional[str] = None


class RunTotals(BaseModel):
    # Helper nested under RunResult.totals. NOT a cross-module shape on its own.
    model_config = Forbid
    shots: int = 0
    blocked: int = 0
    high: int = 0
    at_risk_hours: float = 0.0
    hours_saved: float = 0.0
    mcp_calls: int = 0


class RunResult(BaseModel):
    model_config = Forbid
    trace_id: str
    plan: QueryPlan
    evidence: list[GrafanaEvidence] = Field(default_factory=list)
    findings: list[IncidentFinding] = Field(default_factory=list)
    actions: list[RemediationAction] = Field(default_factory=list)
    receipts: list[WriteReceipt] = Field(default_factory=list)
    revised_shots: list[ProductionShot] = Field(default_factory=list)
    totals: RunTotals = Field(default_factory=RunTotals)
    summary_markdown: str = ""
    degraded: bool = False
    degraded_reasons: list[str] = Field(default_factory=list)


_SCHEMA_DIR = Path(__file__).resolve().parent


def load_schema(name: str) -> dict:
    """Return parsed JSON Schema dict for short name, e.g. "query-plan".

    Never hand-build paths at call sites. Raises FileNotFoundError if missing.
    Valid names: production-shot, delivery-commitment, query-plan-step,
    query-plan, grafana-evidence, incident-finding, remediation-action,
    write-receipt, input, output.
    """
    path = _SCHEMA_DIR / f"{name}.schema.json"
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)
