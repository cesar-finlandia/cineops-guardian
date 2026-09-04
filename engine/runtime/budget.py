from __future__ import annotations
import json
import math
from pathlib import Path

_PROFILES_PATH = Path("config/model-profiles.json")
_RESERVED_OUTPUT = 1024
_WARN_AT = 0.8
_CRIT_AT = 0.95
_STRATEGY = "sliding-window-pinned"
_FALLBACK_WINDOW = 1048576

def _count_tokens(text: str) -> int:
    return int(math.ceil(len(text) / 4))

def _context_window(model_profile: str) -> tuple[int, str]:
    try:
        profiles = json.loads(_PROFILES_PATH.read_text(encoding="utf-8")).get("profiles", {})
        hit = profiles.get(model_profile)
        if isinstance(hit, dict) and int(hit.get("context_window", 0)) > 0:
            return int(hit["context_window"]), model_profile
    except Exception:
        pass
    return _FALLBACK_WINDOW, "gemini-flash"

def _msg_tokens(m: dict) -> int:
    role = str(m.get("role", ""))
    content = m.get("content", "")
    text = role + "\n" + (content if isinstance(content, str) else json.dumps(content, default=str))
    return _count_tokens(text)

def fit_prompt(messages: list[dict], model_profile: str = "gemini-flash") -> tuple[list[dict], dict]:
    N, profile = _context_window(model_profile)
    input_budget = N - _RESERVED_OUTPUT
    # shallow copy list, and shallow copy each dict to avoid mutating input
    fitted = [dict(m) for m in messages]
    total = sum(_msg_tokens(m) for m in fitted)
    evicted_count = 0
    truncated = False

    if not fitted:
        total = 0
    elif total > input_budget:
        # Evict oldest non-system messages (pin system at index 0 if present)
        while total > input_budget and len(fitted) > 1:
            # Find index to evict: oldest non-system not at pinned system index
            evict_idx = None
            start = 1 if fitted and fitted[0].get("role") == "system" else 0
            # If we pin system at 0, search from 1
            for i in range(start, len(fitted)):
                if fitted[i].get("role") != "system":
                    evict_idx = i
                    break
            # If no non-system found (all system), evict from start
            if evict_idx is None:
                # No non-system candidate, try any beyond pinned
                if len(fitted) > 1:
                    evict_idx = start
                else:
                    break
            fitted.pop(evict_idx)
            evicted_count += 1
            truncated = True
            total = sum(_msg_tokens(m) for m in fitted)
        # Single-oversize rule
        if total > input_budget and len(fitted) >= 1:
            # If exactly one non-system remains (system+one) or single message alone
            # Determine which message to truncate
            target_idx = None
            if len(fitted) == 1:
                target_idx = 0
            elif len(fitted) == 2 and fitted[0].get("role") == "system":
                # one system + one non-system
                target_idx = 1
            elif len(fitted) == 1:
                target_idx = 0
            # Also handle case where after eviction we still have >1 but still over budget (should not happen with tiny messages, but handle)
            # If still over and we have a single non-system left, truncate it
            if target_idx is not None:
                # Truncate content to input_budget * 4 characters (inverse heuristic)
                # For system+user case, we truncate the non-system to budget*4, but system remains
                # This matches spec: truncate from END to input_budget*4 chars
                m = fitted[target_idx]
                content = m.get("content", "")
                if isinstance(content, str):
                    # Keep only first input_budget*4 chars
                    limit = input_budget * 4
                    if len(content) > limit:
                        m["content"] = content[:limit]
                        fitted[target_idx] = m
                        truncated = True
                        total = sum(_msg_tokens(x) for x in fitted)
                else:
                    # Non-string content: stringify then truncate, but preserve type? For simplicity, dump then slice then keep string
                    as_str = json.dumps(content, default=str)
                    limit = input_budget * 4
                    if len(as_str) > limit:
                        # Truncate stringified version and set as string content
                        m["content"] = as_str[:limit]
                        fitted[target_idx] = m
                        truncated = True
                        total = sum(_msg_tokens(x) for x in fitted)
            else:
                # Fallback: if still over with multiple messages, truncate last message's content
                # This is defensive, not spec, but ensures we fit
                if total > input_budget and len(fitted) > 0:
                    last_idx = len(fitted) - 1
                    # Don't truncate pinned system if it's the only system; truncate last non-system
                    for i in range(len(fitted) - 1, -1, -1):
                        if fitted[i].get("role") != "system":
                            last_idx = i
                            break
                    m = fitted[last_idx]
                    content = m.get("content", "")
                    if isinstance(content, str):
                        limit = input_budget * 4
                        if len(content) > limit:
                            m["content"] = content[:limit]
                            fitted[last_idx] = m
                            truncated = True
                            total = sum(_msg_tokens(x) for x in fitted)
        # If still over after truncation (e.g., system alone huge), ensure we report exceeded
        # total already recomputed

    # Recompute final total
    total = sum(_msg_tokens(m) for m in fitted) if fitted else 0
    utilization = (total / input_budget) if input_budget > 0 else 0.0

    if truncated and total > input_budget:
        warning = "exceeded"
    elif utilization >= _CRIT_AT:
        warning = "exceeded"
    elif utilization >= _WARN_AT:
        warning = "approaching"
    else:
        warning = "none"

    # Per spec: warning exceeded if utilization >=0.95 or any truncation happened while still over budget
    # We already handled truncated+still over => exceeded
    # For truncated but now fitting, warning may be approaching/none unless utilization high
    # Ensure truncated+still over sets exceeded
    if truncated and total > input_budget:
        warning = "exceeded"

    rejected = False
    reason = "over_budget_after_truncation" if warning == "exceeded" else None

    status = {
        "model_profile": profile,
        "context_window": N,
        "reserved_output": _RESERVED_OUTPUT,
        "strategy": _STRATEGY,
        "strategy_options": {
            "total_tokens": total,
            "input_budget": input_budget,
            "utilization": utilization,
            "truncated": truncated,
            "evicted_count": evicted_count,
            "warning": warning,
            "rejected": rejected,
            "reason": reason,
            "strategy": _STRATEGY,
            "model_profile": profile,
        },
        "warning_threshold": _WARN_AT,
        "critical_threshold": _CRIT_AT,
        "mutate": False,
        "compaction": None,
    }
    return fitted, status
