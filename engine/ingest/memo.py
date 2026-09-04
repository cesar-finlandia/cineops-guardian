# CineOps Guardian — memo commitment extraction (DP-INGEST §3.2).
# Gemini multimodal structured output + sidecar degraded fallback.
# Single owner of extract_commitments. No src/media import.
from __future__ import annotations

import json
import logging
import re
from pathlib import Path

from engine.schema.domain import DeliveryCommitment, load_schema
from engine.providers.gemini import generate_structured
from engine.runtime.budget import fit_prompt
from src.resilience.degraded import is_degraded_result

_logger = logging.getLogger("engine.ingest.memo")

PROMPT_PATH: str = "engine/prompts/extract_memo.md"
SIDECAR_PATH: str = "engine/rag/corpus/memos/commitments.json"
FALLBACK_CONFIDENCE: float = 0.5
LABEL: str = "ingest-extract-commitments"
_FALLBACK_DUE_AT: str = "2026-09-12T00:00:00Z"


def _load_prompt() -> str:
    with open(PROMPT_PATH, "r", encoding="utf-8") as fh:
        return fh.read()


def _coerce_due_at(raw: object) -> str:
    try:
        from datetime import datetime, timezone

        text = str(raw).strip()
        if not text:
            raise ValueError("empty due_at")
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, TypeError, AttributeError):
        return _FALLBACK_DUE_AT


def _derive_id(deliverable: str, due_at: str, production: str, index: int) -> str:
    slug = re.sub(r"[^A-Z0-9]+", "-", deliverable.upper()).strip("-")
    date_part = due_at[:10] if due_at else "NODATE"
    base = f"C-{production.replace(' ', '').upper()}-{slug}-{date_part}" if slug else ""
    return base or f"C-UNKNOWN-{index}"


def _coerce_commitments(
    raw: object, *, production: str, source_file: str
) -> list[DeliveryCommitment]:
    if isinstance(raw, list):
        items: list = list(raw)
    elif isinstance(raw, dict):
        if isinstance(raw.get("items"), list):
            items = list(raw["items"])
        elif isinstance(raw.get("commitments"), list):
            items = list(raw["commitments"])
        elif "deliverable" in raw:
            items = [raw]
        else:
            items = []
    else:
        items = []
    out: list[DeliveryCommitment] = []
    for index, item in enumerate(items):
        if not isinstance(item, dict):
            _logger.warning("ingest: skipping non-dict commitment item %r", item)
            continue
        try:
            deliverable = str(item.get("deliverable", "") or "").strip()
            due_at = _coerce_due_at(item.get("due_at", ""))
            covers = item.get("covers_shot_ids", [])
            if isinstance(covers, str):
                covers = [t.strip() for t in re.split(r"[;,]", covers) if t.strip()]
            elif isinstance(covers, list):
                covers = [str(x).strip() for x in covers if str(x).strip()]
            else:
                covers = []
            try:
                confidence = float(item.get("confidence", 1.0))
            except (ValueError, TypeError):
                confidence = 1.0
            confidence = min(1.0, max(0.0, confidence))
            page_refs: list[int] = []
            for x in item.get("page_refs", []) or []:
                try:
                    page_refs.append(int(x))
                except (ValueError, TypeError):
                    continue
            synthetic = "engine/rag/corpus/" in Path(source_file).as_posix()
            out.append(
                DeliveryCommitment(
                    commitment_id=str(item.get("commitment_id") or _derive_id(deliverable, due_at, production, index)),
                    source_file=Path(source_file).name,
                    production=production,
                    deliverable=deliverable,
                    covers_shot_ids=covers,
                    due_at=due_at,
                    owner=str(item.get("owner", "") or "").strip(),
                    notes=str(item.get("notes", "") or ""),
                    confidence=confidence,
                    page_refs=page_refs,
                    synthetic=synthetic,
                )
            )
        except Exception as exc:
            _logger.warning("ingest: skipping invalid commitment item (%s)", exc)
    return out


def _sidecar_fallback(pdf_path: str, *, production: str, reason: str) -> list[DeliveryCommitment]:
    try:
        with open(SIDECAR_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        _logger.warning("ingest: sidecar absent/unparsable: %s", exc)
        return []
    base = Path(pdf_path).name
    rows = [d for d in data if isinstance(d, dict) and str(d.get("source_file", "")).strip() == base]
    if not rows:
        _logger.warning("ingest: sidecar has no entry for %s (reason=%s)", base, reason)
        return []
    out: list[DeliveryCommitment] = []
    for d in rows:
        try:
            out.append(DeliveryCommitment(**{**d, "production": production, "confidence": FALLBACK_CONFIDENCE}))
        except Exception as exc:
            _logger.warning("ingest: skipping invalid sidecar row (%s)", exc)
    return out


def extract_commitments(pdf_path: str, *, production: str) -> list[DeliveryCommitment]:
    prompt_text = _load_prompt()
    messages = [{"role": "user", "content": prompt_text}]
    messages, _status = fit_prompt(messages, model_profile="gemini-flash")
    prompt = messages[-1]["content"] if messages else prompt_text
    schema = load_schema("delivery-commitment")
    raw = generate_structured(prompt, schema, files=[pdf_path], label=LABEL)
    if is_degraded_result(raw):
        return _sidecar_fallback(pdf_path, production=production, reason=str(raw.get("reason", "degraded")))
    if not isinstance(raw, (dict, list)):
        return _sidecar_fallback(pdf_path, production=production, reason="unexpected_shape")
    coerced = _coerce_commitments(raw, production=production, source_file=pdf_path)
    if not coerced:
        degraded_reason = "empty_extraction"
        if isinstance(raw, dict) and is_degraded_result(raw):
            degraded_reason = str(raw.get("reason", "degraded"))
        return _sidecar_fallback(pdf_path, production=production, reason=degraded_reason)
    return coerced
