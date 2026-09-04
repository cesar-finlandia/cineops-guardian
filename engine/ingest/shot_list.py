# CineOps Guardian — shot-list ingest (DP-INGEST §3.1).
# Deterministic CSV parse. NEVER makes an LLM call: no gemini import,
# no prompt read, no network. Single owner of extract_shot_list.
from __future__ import annotations

import csv
import logging
from datetime import datetime, timezone
from pathlib import Path

from engine.schema.domain import ProductionShot

_logger = logging.getLogger("engine.ingest.shot_list")

REQUIRED_HEADER: list[str] = [
    "shot_id",
    "production",
    "episode_or_reel",
    "scene",
    "vfx_vendor",
    "status",
    "priority",
    "due_at",
    "render_job_id",
    "dependency_shot_ids",
]

FALLBACK_DUE_AT: str = "2026-09-12T00:00:00Z"


def _coerce_priority(raw: object, shot_id: str) -> int:
    try:
        val = int(str(raw).strip())
    except (ValueError, TypeError, AttributeError):
        _logger.warning("ingest: shot %s bad priority %r; using 3", shot_id, raw)
        return 3
    if val < 1:
        return 1
    if val > 5:
        return 5
    return val


def _coerce_due_at(raw: object, shot_id: str) -> str:
    try:
        text = str(raw).strip()
        if not text:
            raise ValueError("empty due_at")
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError, AttributeError):
        _logger.warning("ingest: shot %s bad due_at %r; using fallback", shot_id, raw)
        return FALLBACK_DUE_AT


def _coerce_deps(raw: object) -> list[str]:
    if raw is None:
        return []
    return [t.strip() for t in str(raw).split(";") if t.strip()]


def extract_shot_list(path: str, *, production: str) -> list[ProductionShot]:
    p = Path(path)
    with open(p, "r", encoding="utf-8", newline="") as fh:
        reader = csv.DictReader(fh)
        actual = list(reader.fieldnames or [])
        if actual != REQUIRED_HEADER:
            raise ValueError(f"shot_list header mismatch: expected {REQUIRED_HEADER}, got {actual}")
        shots: list[ProductionShot] = []
        for row in reader:
            shot_id = str(row["shot_id"]).strip()
            if not shot_id:
                raise ValueError("shot row with empty shot_id")
            shots.append(
                ProductionShot(
                    shot_id=shot_id,
                    production=production,
                    episode_or_reel=str(row["episode_or_reel"]).strip(),
                    scene=str(row["scene"]).strip(),
                    vfx_vendor=str(row["vfx_vendor"]).strip() or None,
                    status=str(row["status"]).strip(),  # type: ignore[arg-type]
                    priority=_coerce_priority(row["priority"], shot_id),
                    due_at=_coerce_due_at(row["due_at"], shot_id),
                    render_job_id=str(row["render_job_id"]).strip() or None,
                    dependency_shot_ids=_coerce_deps(row["dependency_shot_ids"]),
                    synthetic="engine/rag/corpus/" in Path(path).as_posix(),
                )
            )
        return shots
