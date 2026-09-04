# CineOps Guardian — ingest normalize (DP-INGEST §3.3). Pure function, no I/O,
# no LLM, no guard decorator. Single owner of normalize_context.
from __future__ import annotations

import logging

from engine.schema.domain import DeliveryCommitment, ProductionShot

_logger = logging.getLogger("engine.ingest.normalize")


def normalize_context(
    shots: list[ProductionShot],
    commitments: list[DeliveryCommitment],
) -> tuple[list[ProductionShot], list[DeliveryCommitment]]:
    known = {s.shot_id for s in shots}
    seen: set[tuple[str, str, str]] = set()
    deduped: list[DeliveryCommitment] = []
    for c in commitments:
        key = (c.deliverable, c.due_at, c.owner)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(c)
    kept: list[DeliveryCommitment] = []
    for c in deduped:
        if not any(sid in known for sid in c.covers_shot_ids):
            _logger.debug("ingest: dropping orphan commitment %s", c.commitment_id)
            continue
        kept.append(c)
    new_shots: list[ProductionShot] = []
    for s in shots:
        cov = [c for c in kept if s.shot_id in c.covers_shot_ids]
        if not cov:
            new_shots.append(s)
            continue
        best = min(c.due_at for c in cov)
        if best < s.due_at:
            new_shots.append(s.model_copy(update={"due_at": best}))
        else:
            new_shots.append(s)
    return (new_shots, kept)
