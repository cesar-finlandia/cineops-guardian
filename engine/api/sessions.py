# CineOps Guardian — sessions + approval gate (DP-API §3.3).
# Sole gate for human approval in the repo (FR-14). DP-AGENT calls wait(); POST /api/approve releases it.
from __future__ import annotations

import asyncio
from typing import Any

from engine.schema.domain import RemediationAction

APPROVAL_TIMEOUT_SEC = 120.0

SESSIONS: dict[str, dict[str, Any]] = {}
# SESSIONS[trace_id] = {"status": str, "result": RunResult|None,
#   "actions": list[RemediationAction], "event": asyncio.Event, "approved": list[str]}
# status in {"running", "awaiting-approval", "done", "error"}.


def get_session(trace_id: str) -> dict[str, Any]:
    try:
        return SESSIONS[trace_id]
    except KeyError:
        raise KeyError(f"unknown trace_id {trace_id!r}") from None


class HttpApprovalGate:
    """Implements DP-AGENT ApprovalGate: async wait(trace_id, actions) -> list[str]."""

    async def wait(self, trace_id: str, actions: list[RemediationAction]) -> list[str]:
        session = get_session(trace_id)
        session["status"] = "awaiting-approval"
        session["actions"] = list(actions)
        session["approved"] = []
        event: asyncio.Event = session["event"]
        event.clear()
        try:
            await asyncio.wait_for(event.wait(), timeout=APPROVAL_TIMEOUT_SEC)
        except asyncio.TimeoutError:
            session["status"] = "running"
            session["actions"] = []
            return []
        return list(session["approved"])


def release(trace_id: str, action_ids: list[str]) -> int:
    """Called by POST /api/approve. Records approved ids, sets the event. Returns len(approved)."""
    session = get_session(trace_id)
    if session["status"] != "awaiting-approval":
        return 0
    valid_ids = {a.action_id for a in session["actions"]}
    approved = [a for a in action_ids if a in valid_ids]
    session["approved"] = approved
    session["event"].set()
    session["status"] = "running"
    return len(approved)
