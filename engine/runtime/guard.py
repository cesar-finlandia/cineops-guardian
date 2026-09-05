from __future__ import annotations
import functools
import hashlib
import inspect
import json
import logging
from typing import Any, Callable, TypeVar

from src.resilience.wrapper import with_resilience
from src.resilience.degraded import is_degraded_result, make_degraded_result
from src.resilience.cache.store import create_golden_cache
from src.cost.meter import with_cost_guardrail
from src.cost.store import get_default_store

from .config import settings

_logger = logging.getLogger("engine.runtime.guard")
T = TypeVar("T")
F = TypeVar("F", bound=Callable[..., Any])
_CACHE = create_golden_cache()

def _cacheable(value: Any) -> Any:
    """JSON-safe view of a guarded return value (NFR-02, E2E F18).

    The golden cache stores JSON. `mcp_call` returns a `GrafanaEvidence` and
    `propose_remediation` a `list[RemediationAction]`, so every put for those
    two seams failed ("value not JSON-serializable") and the offline rung had
    nothing to replay — exactly the evidence and actions the fallback demo
    needs. Pydantic models are dumped structurally; everything else passes
    through untouched.
    """
    dump = getattr(value, "model_dump", None)
    if callable(dump):
        try:
            return dump(mode="json")
        except Exception:
            return dump()
    if isinstance(value, list):
        return [_cacheable(v) for v in value]
    if isinstance(value, tuple):
        return [_cacheable(v) for v in value]
    if isinstance(value, dict):
        return {k: _cacheable(v) for k, v in value.items()}
    return value


def _identity(value: T) -> T:
    return value


def _derive_key(label: str, args: tuple, kwargs: dict) -> str:
    raw = json.dumps({"label": label, "args": args, "kwargs": kwargs},
                     sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()

def guarded(label: str, *, provider: str = "google",
            cache_key: str | None = None, config: dict | None = None,
            revive: Callable[[Any], Any] | None = None) -> Callable[[F], F]:
    """`revive` rehydrates a value that came back from the golden cache (a
    plain dict/list) into the type the call site declares. It must be a no-op
    for live values, so it only ever runs on cache-shaped input (E2E F18)."""
    revive_fn = revive or _identity

    def decorator(fn: F) -> F:
        metered = with_cost_guardrail(fn, {"provider": provider, "label": label})
        key = cache_key or label
        guarded_fn = with_resilience(metered, config, {"cache": _CACHE, "cache_key": key})
        if settings.forced_degraded:
            @functools.wraps(fn)
            def forced_sync(*a: Any, **k: Any) -> Any:
                hit = _CACHE.get(key) or _CACHE.get("replay::" + key)
                if hit is not None:
                    return revive_fn(hit)
                return make_degraded_result(reason="forced_degraded", fallback_source="none",
                    original_error="RES_FORCED_DEGRADED=1 and no golden entry for key " + key)
            @functools.wraps(fn)
            async def forced_async(*a: Any, **k: Any) -> Any:
                return forced_sync(*a, **k)
            return forced_async if inspect.iscoroutinefunction(fn) else forced_sync
        if inspect.iscoroutinefunction(fn):
            @functools.wraps(fn)
            async def recording_async(*a: Any, **k: Any) -> Any:
                result = await guarded_fn(*a, **k)
                if not is_degraded_result(result):
                    _CACHE.put(cache_key or _derive_key(label, a, k), _cacheable(result))
                    return revive_fn(result)
                return result
            return recording_async
        @functools.wraps(fn)
        def recording_sync(*a: Any, **k: Any) -> Any:
            result = guarded_fn(*a, **k)
            if inspect.isawaitable(result):
                return result
            if not is_degraded_result(result):
                _CACHE.put(cache_key or _derive_key(label, a, k), _cacheable(result))
                return revive_fn(result)
            return result
        return recording_sync
    return decorator

def unwrap(value: T | dict, default: T, reasons: list[str]) -> T:
    if is_degraded_result(value):
        reasons.append(value["reason"])
        return default
    return value

def cost_snapshot() -> dict:
    try:
        g = get_default_store().global_totals()
        spent = float(g.get("estimated_cost_usd") or 0.0)
        calls = int(g.get("request_count") or 0)
        budget = float(settings.cost_budget_usd)
        if spent > budget:
            _logger.warning("[guard] budget exceeded: spent=%s budget=%s (run continues)", spent, budget)
        return {"usd_spent": spent, "budget_usd": budget, "calls": calls, "over_budget": spent > budget}
    except Exception as err:
        _logger.warning("[guard] cost_snapshot failed (%s); returning zeros", err)
        try:
            budget = float(settings.cost_budget_usd)
        except Exception:
            budget = 100.0
        return {"usd_spent": 0.0, "budget_usd": budget, "calls": 0, "over_budget": False}
