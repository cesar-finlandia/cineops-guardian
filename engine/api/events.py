# CineOps Guardian — EventEnvelope publisher (DP-API §3.2).
# Sole builder of EventEnvelope in the repo. DP-AGENT fills payloads; this module builds + validates + fans out.
from __future__ import annotations

import itertools
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol

from src.platform.transport.stream_router import HUB
from src.resilience.validate import validate

from engine.schema.domain import STEP_IDS

_APPROVED_STATUSES = ("started", "streaming", "done", "error")
_SCHEMA_PATH = Path(__file__).resolve().parents[2] / "contracts" / "event-envelope.schema.json"
_SCHEMA: dict | None = None


def _schema() -> dict:
    global _SCHEMA
    if _SCHEMA is None:
        with open(_SCHEMA_PATH, "r", encoding="utf-8") as fh:
            _SCHEMA = json.load(fh)
    return _SCHEMA


class PublishFn(Protocol):
    async def __call__(self, step_id: str, status: str, payload: dict, *, degraded: bool = False) -> None: ...


def make_publisher(trace_id: str) -> PublishFn:
    counter = itertools.count(0)

    async def publish(step_id: str, status: str, payload: dict, *, degraded: bool = False) -> None:
        if step_id not in STEP_IDS:
            raise ValueError(f"unknown step_id {step_id!r}; expected one of {list(STEP_IDS)}")
        if status not in _APPROVED_STATUSES:
            raise ValueError(f"unknown status {status!r}; expected one of {list(_APPROVED_STATUSES)}")
        envelope = {
            "step_id": step_id,
            "status": status,
            "payload": payload,
            "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "sequence": next(counter),
            "trace_id": trace_id,
            "degraded": degraded,
        }
        result = validate(_schema(), envelope)
        if not result["valid"]:
            raise ValueError(f"envelope failed chassis validation: {result['errors']}")
        await HUB.publish(envelope)

    return publish
