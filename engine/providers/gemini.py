# CineOps Guardian — Vertex AI google-genai provider (DP-GEMINI §3).
# Single owner of GEMINI_MODEL, build_adk_model, generate_text,
# generate_structured, gemini_health. No prompt content. No retry/backoff
# of its own (DP-GUARD @guarded only). No os.environ reads. No non-Google SDK.
from __future__ import annotations

import json
import logging
import time
from pathlib import Path

from google.genai import Client, types

from engine.runtime.config import settings
from engine.runtime.guard import guarded
from engine.runtime.budget import fit_prompt
from src.resilience.validate import validate, render_repair_prompt
from src.resilience.degraded import is_degraded_result, make_degraded_result

_logger = logging.getLogger("engine.providers.gemini")

GEMINI_MODEL: str = settings.gemini_model

_MIME_BY_SUFFIX: dict[str, str] = {
    ".pdf": "application/pdf",
    ".csv": "text/csv",
    ".txt": "text/plain",
}
MAX_INLINE_FILE_BYTES: int = 20 * 1024 * 1024
_HEALTH_TTL_S: float = 30.0
_HEALTH_CACHE: dict = {"at": 0.0, "value": None}
_CLIENT: Client | None = None


def _client() -> Client:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = Client(
            vertexai=True,
            project=settings.gcp_project or None,
            location=settings.gcp_location or None,
        )
    return _CLIENT


def build_adk_model() -> str:
    return GEMINI_MODEL


def _inline_part(path: str):
    p = Path(path)
    if not p.is_file():
        return make_degraded_result(reason="missing_file", fallback_source="none", original_error="file not found: " + path)
    suffix = p.suffix.lower()
    mime = _MIME_BY_SUFFIX.get(suffix)
    if mime is None:
        return make_degraded_result(reason="unsupported_media_type", fallback_source="none", original_error="unsupported suffix for file: " + path)
    try:
        size = p.stat().st_size
    except Exception as exc:
        return make_degraded_result(reason="missing_file", fallback_source="none", original_error=str(exc)[:500])
    if size > MAX_INLINE_FILE_BYTES:
        return make_degraded_result(reason="file_too_large", fallback_source="none", original_error=f"file {path} is {size} bytes; cap is {MAX_INLINE_FILE_BYTES}")
    try:
        data = p.read_bytes()
    except Exception as exc:
        return make_degraded_result(reason="missing_file", fallback_source="none", original_error=str(exc)[:500])
    # Preferred: from_bytes
    try:
        if hasattr(types.Part, "from_bytes"):
            return types.Part.from_bytes(data=data, mime_type=mime)
        # Fallback: inline_data Blob
        return types.Part(inline_data=types.Blob(data=data, mime_type=mime))
    except Exception as exc:
        return make_degraded_result(reason="unsupported_media_type", fallback_source="none", original_error=str(exc)[:500])


@guarded("gemini-generate-text", provider="google")
def generate_text(prompt: str, *, system: str | None = None, label: str) -> str | dict:
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    messages, _status = fit_prompt(messages, model_profile="gemini-flash")
    if not messages:
        messages = [{"role": "user", "content": prompt}]
    # Map to SDK contents
    contents: list = []
    for m in messages:
        raw_content = m.get("content", "")
        text = str(raw_content) if raw_content is not None else ""
        if not text:
            continue
        role = m.get("role", "user")
        sdk_role = "user" if role == "user" else "model"
        # Prefer from_text, fallback to Part(text=...)
        try:
            if hasattr(types.Part, "from_text"):
                part = types.Part.from_text(text=text)
            else:
                part = types.Part(text=text)
        except Exception:
            part = types.Part(text=text)
        contents.append(types.Content(role=sdk_role, parts=[part]))
    if not contents:
        # Ensure at least one content
        try:
            if hasattr(types.Part, "from_text"):
                part = types.Part.from_text(text=str(prompt))
            else:
                part = types.Part(text=str(prompt))
        except Exception:
            part = types.Part(text=str(prompt))
        contents = [types.Content(role="user", parts=[part])]
    resp = _client().models.generate_content(
        model=GEMINI_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            temperature=float(settings.gemini_temperature),
            response_mime_type="text/plain",
        ),
    )
    text = "".join(getattr(p, "text", "") or "" for c in (resp.candidates or []) for p in (getattr(c.content, "parts", None) or []))
    if not text:
        return make_degraded_result(reason="empty_response", fallback_source="none", original_error="gemini returned no text parts")
    return text


@guarded("gemini-generate-structured", provider="google")
def generate_structured(
    prompt: str,
    schema: dict,
    *,
    system: str | None = None,
    files: list[str] | None = None,
    label: str,
) -> dict:
    # Build messages as in generate_text
    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})
    messages, _status = fit_prompt(messages, model_profile="gemini-flash")
    if not messages:
        messages = [{"role": "user", "content": prompt}]
    # Build parts for structured call: single user Content with prompt + file parts
    # Determine user prompt text after fitting
    user_text = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            user_text = str(m.get("content", ""))
            break
    if not user_text:
        user_text = str(prompt)
    # Build parts list
    parts: list = []
    # System text part prepended if present
    if system:
        try:
            if hasattr(types.Part, "from_text"):
                parts.append(types.Part.from_text(text=str(system)))
            else:
                parts.append(types.Part(text=str(system)))
        except Exception:
            parts.append(types.Part(text=str(system)))
    try:
        if hasattr(types.Part, "from_text"):
            parts.append(types.Part.from_text(text=user_text))
        else:
            parts.append(types.Part(text=user_text))
    except Exception:
        parts.append(types.Part(text=user_text))
    # Attach files
    for fpath in files or []:
        part = _inline_part(fpath)
        if is_degraded_result(part):
            return part
        parts.append(part)
    contents = [types.Content(role="user", parts=parts)]
    resp = _client().models.generate_content(
        model=GEMINI_MODEL,
        contents=contents,
        config=types.GenerateContentConfig(
            temperature=float(settings.gemini_temperature),
            response_mime_type="application/json",
        ),
    )
    raw = "".join(getattr(p, "text", "") or "" for c in (resp.candidates or []) for p in (getattr(c.content, "parts", None) or []))
    # Fence strip
    stripped = raw.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```"):
            raw = "\n".join(lines[1:])
            # Remove trailing fence
            if raw.rstrip().endswith("```"):
                raw = raw.rstrip()[: raw.rstrip().rfind("```")]
        else:
            raw = stripped
    else:
        raw = stripped
    # Parse
    parsed = None
    parse_ok = True
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        parse_ok = False
        parse_error = exc
        parsed = None
    # Validate if parsed
    if parse_ok and parsed is not None:
        r = validate(schema, parsed)
        if r["valid"] is True:
            # Must be dict per spec
            if isinstance(parsed, dict):
                return parsed
            return make_degraded_result(reason="unexpected_json_shape", fallback_source="none", original_error="parsed json is not an object")
        # Prepare repair
        errors = r["errors"]
    else:
        errors = [{"path": "", "message": "output was not valid JSON", "code": "json_parse_error"}]
    # Single repair retry
    repair_prompt = render_repair_prompt(errors, raw)
    try:
        if hasattr(types.Part, "from_text"):
            repair_part = types.Part.from_text(text=prompt + "\n\n" + repair_prompt)
        else:
            repair_part = types.Part(text=prompt + "\n\n" + repair_prompt)
    except Exception:
        repair_part = types.Part(text=prompt + "\n\n" + repair_prompt)
    resp2 = _client().models.generate_content(
        model=GEMINI_MODEL,
        contents=[types.Content(role="user", parts=[repair_part])],
        config=types.GenerateContentConfig(
            temperature=float(settings.gemini_temperature),
            response_mime_type="application/json",
        ),
    )
    raw2 = "".join(getattr(p, "text", "") or "" for c in (resp2.candidates or []) for p in (getattr(c.content, "parts", None) or []))
    stripped2 = raw2.strip()
    if stripped2.startswith("```"):
        lines2 = stripped2.splitlines()
        if lines2 and lines2[0].startswith("```"):
            raw2 = "\n".join(lines2[1:])
            if raw2.rstrip().endswith("```"):
                raw2 = raw2.rstrip()[: raw2.rstrip().rfind("```")]
        else:
            raw2 = stripped2
    else:
        raw2 = stripped2
    try:
        parsed2 = json.loads(raw2)
    except json.JSONDecodeError as exc:
        return make_degraded_result(reason="json_parse_error", fallback_source="none", original_error=str(exc)[:500])
    r2 = validate(schema, parsed2)
    if r2["valid"] is True:
        if isinstance(parsed2, dict):
            return parsed2
        return make_degraded_result(reason="unexpected_json_shape", fallback_source="none", original_error="parsed json is not an object")
    return make_degraded_result(reason="schema_validation_failed", fallback_source="none", original_error=json.dumps(r2["errors"])[:2000])


def gemini_health() -> dict:
    try:
        now = time.monotonic()
        cached = _HEALTH_CACHE.get("value")
        at = _HEALTH_CACHE.get("at", 0.0)
        if cached is not None and (now - at) < _HEALTH_TTL_S:
            return cached
        # Probe
        resp = _client().models.generate_content(
            model=GEMINI_MODEL,
            contents="Reply with exactly: OK",
            config=types.GenerateContentConfig(temperature=0.0, response_mime_type="text/plain", max_output_tokens=8),
        )
        text = "".join(getattr(p, "text", "") or "" for c in (resp.candidates or []) for p in (getattr(c.content, "parts", None) or []))
        reachable = bool(text)
        if reachable:
            value = {"reachable": True, "model": GEMINI_MODEL, "mode": "vertex", "project": settings.gcp_project, "location": settings.gcp_location, "last_error": None}
        else:
            value = {"reachable": False, "model": GEMINI_MODEL, "mode": "vertex", "project": settings.gcp_project, "location": settings.gcp_location, "last_error": "empty_response"}
        _HEALTH_CACHE["at"] = now
        _HEALTH_CACHE["value"] = value
        return value
    except Exception as exc:
        try:
            now = time.monotonic()
            value = {"reachable": False, "model": GEMINI_MODEL, "mode": "vertex", "project": settings.gcp_project, "location": settings.gcp_location, "last_error": str(exc)[:500]}
            _HEALTH_CACHE["at"] = now
            _HEALTH_CACHE["value"] = value
            return value
        except Exception:
            return {"reachable": False, "model": GEMINI_MODEL, "mode": "vertex", "project": "", "location": "", "last_error": "health_failed"}
