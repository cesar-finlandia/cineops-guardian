"""DP-SCHEMA A3 — Python<->JSON-Schema equivalence check (WU-SCHEMA-03)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
# Ensure repo root on sys.path for `engine.*` and `src.*` imports when run as `python3 scripts/...`
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from typing import get_args, get_origin, Literal

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
    RunResult,
    MAX_PLAN_STEPS,
)

# Map Model -> schema short name
PAIRS = [
    (ProductionShot, "production-shot"),
    (DeliveryCommitment, "delivery-commitment"),
    (QueryPlanStep, "query-plan-step"),
    (QueryPlan, "query-plan"),
    (GrafanaEvidence, "grafana-evidence"),
    (IncidentFinding, "incident-finding"),
    (RemediationAction, "remediation-action"),
    (WriteReceipt, "write-receipt"),
    (RunRequest, "input"),
    (RunResult, "output"),
]

SCHEMA_DIR = Path("engine/schema")


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def is_literal_type(ann) -> bool:
    # Handles Literal and Optional[Literal] (Union)
    origin = get_origin(ann)
    # Direct Literal
    if origin is Literal:
        return True
    # Optional[Literal] is Union[Literal, NoneType]
    if origin is not None:
        # Union with Literal inside
        for arg in get_args(ann):
            if get_origin(arg) is Literal or arg is Literal:
                return True
            if get_origin(arg) is Literal:
                return True
        # Check if any arg is Literal type
        for arg in get_args(ann):
            if get_origin(arg) is Literal:
                return True
    return False


def extract_enum_values(ann):
    """Return tuple of literal values if ann is Literal or Optional[Literal], else None."""
    origin = get_origin(ann)
    if origin is Literal:
        return tuple(get_args(ann))
    # Union (Optional)
    if hasattr(ann, "__args__") or origin is not None:
        args = get_args(ann)
        for a in args:
            if get_origin(a) is Literal:
                return tuple(get_args(a))
        # Direct args that are Literal values without wrapper? get_args may return literals
        # For Optional[Literal["a","b"]] -> args = (Literal["a","b"], NoneType)
        # So we already handled above.
    return None


def main() -> None:
    # 1-5 for each pair
    for Model, name in PAIRS:
        path = SCHEMA_DIR / f"{name}.schema.json"
        if not path.exists():
            fail(f"missing schema file {path}")
        schema = json.loads(path.read_text(encoding="utf-8"))

        # 2: fields == props
        fields = set(Model.model_fields.keys())
        props = set(schema.get("properties", {}).keys())
        if fields != props:
            fail(
                f"{name}: field mismatch fields={sorted(fields)} props={sorted(props)} diff_fields_minus_props={sorted(fields - props)} diff_props_minus_fields={sorted(props - fields)}"
            )

        # 3: required sets equal is_required()
        py_required = {k for k, f in Model.model_fields.items() if f.is_required()}
        schema_required = set(schema.get("required", []))
        if schema_required != py_required:
            fail(
                f"{name}: required mismatch py_required={sorted(py_required)} schema_required={sorted(schema_required)}"
            )

        # 4: Literal enums mirrored verbatim
        for fname, field in Model.model_fields.items():
            ann = field.annotation
            # Try to extract literal values (field.annotation may be string due to future annotations, use Model.__annotations__ or evaluate)
            # Use field.annotation first, fallback to evaluating via typing
            literal_vals = None
            try:
                # field.annotation may be a string if from __future__ annotations not evaluated; use Model.model_fields[fname].annotation already evaluated by pydantic
                literal_vals = extract_enum_values(ann)
            except Exception:
                literal_vals = None
            # Also try to get from the actual annotation in the model namespace if string
            if literal_vals is None and isinstance(ann, str):
                # Not expected after pydantic evaluation, skip
                continue
            if literal_vals is not None:
                # Find JSON enum
                prop = schema["properties"][fname]
                # Nullable enum has type ["string","null"] but enum still present
                json_enum = prop.get("enum")
                if json_enum is None:
                    fail(f"{name}.{fname}: expected enum {list(literal_vals)} but schema has no enum")
                if list(json_enum) != list(literal_vals):
                    fail(
                        f"{name}.{fname}: enum mismatch json={json_enum} py={list(literal_vals)}"
                    )

        # 5: additionalProperties false and $schema contains 2020-12
        if schema.get("additionalProperties") is not False:
            fail(f"{name}: additionalProperties must be false, got {schema.get('additionalProperties')}")
        if "2020-12" not in str(schema.get("$schema", "")):
            fail(f"{name}: $schema must contain 2020-12, got {schema.get('$schema')}")

    # 6: query-plan specifics
    qp_path = SCHEMA_DIR / "query-plan.schema.json"
    qp = json.loads(qp_path.read_text(encoding="utf-8"))
    steps = qp.get("properties", {}).get("steps", {})
    if steps.get("minItems") != 1 or steps.get("maxItems") != MAX_PLAN_STEPS:
        fail(f"query-plan steps minItems/maxItems expected 1/{MAX_PLAN_STEPS} got {steps.get('minItems')}/{steps.get('maxItems')}")

    qps_path = SCHEMA_DIR / "query-plan-step.schema.json"
    qps = json.loads(qps_path.read_text(encoding="utf-8"))
    defs = qp.get("$defs", {}).get("queryPlanStep")
    if defs is None:
        fail("query-plan missing $defs.queryPlanStep")
    # Compare $defs vs standalone minus $schema/$id/title
    # Remove $schema, $id, title from qps for comparison, and title from defs? Spec says minus title/$schema keys
    qps_copy = {k: v for k, v in qps.items() if k not in ("$schema", "$id")}
    # Also remove $id from defs if present? defs shouldn't have $schema/$id anyway
    defs_copy = dict(defs)
    # Both have title; spec says other nine follow template, but A3 says $defs == query-plan-step minus title/$schema keys — meaning ignore those keys
    # We'll compare after removing title as well for leniency, but spec says minus title/$schema => so remove title and $schema from both
    for key in ("$schema", "$id", "title"):
        qps_copy.pop(key, None)
        defs_copy.pop(key, None)
    # However we kept title in defs originally; if we remove title from both, they should match
    # Alternative: keep title and compare including title — both have title QueryPlanStep, so they match either way
    # For strict check, compare with title retained; if mismatch due to title handling, try without title
    if qps_copy != defs_copy:
        # Retry comparing with title included (if both have same title)
        qps_with_title = {k: v for k, v in qps.items() if k not in ("$schema", "$id")}
        defs_with_title = dict(defs)
        if qps_with_title != defs_with_title:
            fail(
                f"query-plan $defs.queryPlanStep != query-plan-step.schema.json\ndiff qps_copy={json.dumps(qps_copy, sort_keys=True)}\ndefs_copy={json.dumps(defs_copy, sort_keys=True)}"
            )

    print("SCHEMA-EQUIV-OK")


if __name__ == "__main__":
    main()
