"""DP-SCHEMA A4 — Python<->TypeScript field-name equivalence check (WU-SCHEMA-04)."""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.schema.domain import (
    ProductionShot,
    DeliveryCommitment,
    QueryPlanStep,
    QueryPlan,
    GrafanaEvidence,
    IncidentFinding,
    RemediationAction,
    WriteReceipt,
    RunRequest,
    RunTotals,
    RunResult,
    STEP_IDS,
)

MAPPING = {
    "ProductionShot": "CineOpsProductionShot",
    "DeliveryCommitment": "CineOpsDeliveryCommitment",
    "QueryPlanStep": "CineOpsQueryPlanStep",
    "QueryPlan": "CineOpsQueryPlan",
    "GrafanaEvidence": "CineOpsGrafanaEvidence",
    "IncidentFinding": "CineOpsIncidentFinding",
    "RemediationAction": "CineOpsRemediationAction",
    "WriteReceipt": "CineOpsWriteReceipt",
    "RunRequest": "CineOpsRunRequest",
    "RunResult": "CineOpsRunResult",
    "RunTotals": "CineOpsRunTotals",
}

MODELS = {
    "ProductionShot": ProductionShot,
    "DeliveryCommitment": DeliveryCommitment,
    "QueryPlanStep": QueryPlanStep,
    "QueryPlan": QueryPlan,
    "GrafanaEvidence": GrafanaEvidence,
    "IncidentFinding": IncidentFinding,
    "RemediationAction": RemediationAction,
    "WriteReceipt": WriteReceipt,
    "RunRequest": RunRequest,
    "RunTotals": RunTotals,
    "RunResult": RunResult,
}


def parse_typescript(path: Path):
    text = path.read_text(encoding="utf-8")
    # Extract STEP_IDS array
    step_match = re.search(r"export const STEP_IDS[^=]*=\s*\[(.*?)\]\s*as const", text, re.DOTALL)
    ts_step_ids = []
    if step_match:
        inner = step_match.group(1)
        # Find quoted strings
        ts_step_ids = re.findall(r'"([^"]+)"', inner)
    # Extract interfaces
    # Regex for interface CineOpsX { ... }
    iface_re = re.compile(r"export interface (CineOps\w+)\s*\{([^}]*)\}", re.DOTALL)
    interfaces = {}
    for m in iface_re.finditer(text):
        name = m.group(1)
        body = m.group(2)
        # Split by ; to get fields
        fields = []
        for part in body.split(";"):
            part = part.strip()
            if not part:
                continue
            # field is like "shot_id: string" or "vfx_vendor: string | null"
            # split on : to get name
            if ":" in part:
                fname = part.split(":")[0].strip()
                fields.append(fname)
        interfaces[name] = set(fields)
    return ts_step_ids, interfaces


def fail(msg: str):
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def main():
    ts_path = Path("src/cineops/types.ts")
    if not ts_path.exists():
        fail(f"missing {ts_path}")
    ts_step_ids, ts_interfaces = parse_typescript(ts_path)

    # Check STEP_IDS order
    if list(ts_step_ids) != list(STEP_IDS):
        fail(f"STEP_IDS mismatch py={list(STEP_IDS)} ts={ts_step_ids}")

    # Check each model mapping
    for py_name, ts_name in MAPPING.items():
        Model = MODELS[py_name]
        py_fields = set(Model.model_fields.keys())
        ts_fields = ts_interfaces.get(ts_name)
        if ts_fields is None:
            fail(f"missing TypeScript interface {ts_name} for {py_name}")
        if py_fields != ts_fields:
            fail(
                f"{py_name}->{ts_name} field mismatch py={sorted(py_fields)} ts={sorted(ts_fields)} diff_py_minus_ts={sorted(py_fields - ts_fields)} diff_ts_minus_py={sorted(ts_fields - py_fields)}"
            )

    print("TYPES-OK")


if __name__ == "__main__":
    main()
