# CineOps Guardian — EventEnvelope publisher (DP-API §3.2).
# Sole builder of EventEnvelope in the repo. DP-AGENT fills payloads; this module builds + validates + fans out.
from __future__ import annotations

import itertools
import json
from collections import deque
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


# Replay buffer (DP-API, E2E F13): the chassis SSE hub is broadcast-only with
# no history, and its generator closes the connection after ~15 s without an
# envelope. Our runs have multi-minute gaps (memo extraction, MCP timeouts,
# BQ loads, the 120 s approval wait), so a browser that subscribes late or
# reconnects would lose envelopes forever. Every published envelope is also
# appended here (bounded deque per trace); GET /api/events/recent replays
# anything the live stream missed. GIL-atomic appends; readers get snapshots.
RECENT_MAX_TRACES: int = 50
RECENT_MAX_PER_TRACE: int = 1000
RECENT: dict[str, deque] = {}


def _remember(trace_id: str, envelope: dict) -> None:
    buf = RECENT.get(trace_id)
    if buf is None:
        if len(RECENT) >= RECENT_MAX_TRACES:
            oldest = next(iter(RECENT))
            del RECENT[oldest]
        buf = RECENT[trace_id] = deque(maxlen=RECENT_MAX_PER_TRACE)
    buf.append(envelope)


def recent_envelopes(trace_id: str, after: int = -1) -> list[dict]:
    """Envelopes published for trace_id with sequence > after, in order."""
    buf = RECENT.get(trace_id)
    if not buf:
        return []
    return [e for e in list(buf) if isinstance(e.get("sequence"), int) and e["sequence"] > after]


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
        _remember(trace_id, envelope)
        await HUB.publish(envelope)

    return publish
