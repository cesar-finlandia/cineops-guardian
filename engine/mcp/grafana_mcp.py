# CineOps Guardian — Grafana MCP runtime read/write path (DP-MCP §3).
# The only legal runtime read path into Grafana is mcp_call. Reads never fall
# back to the plain HTTP API. Writes fall back to the Grafana HTTP API only
# per §5c (disclosed, path:"rest-fallback").
from __future__ import annotations
import asyncio
import contextlib
import copy
import datetime as dt
import json
import os
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
# NOTE: `streamable_http_client` is the name exported by both mcp 1.29.1 and
# 2.1.1 (verified in the WU-DEPLOY-01 container); the alias without the first
# underscore does not exist there.
from mcp.client.streamable_http import streamable_http_client

from engine.runtime.config import settings
from engine.runtime.guard import guarded, unwrap
from engine.schema.domain import GrafanaEvidence, RemediationAction, WriteReceipt
from src.resilience.degraded import is_degraded_result

MCP_PROOF_LOG: str = "logs/mcp-grafana.jsonl"
_MCP_TIMEOUT_S: float = 20.0
_PINNED_TRANSPORT: str | None = None
_SESSION: Any | None = None
_SESSION_LOCK = threading.Lock()
_TOOL_CACHE: list[str] | None = None
_SCHEMA_CACHE: dict[str, dict] | None = None
_DESC_CACHE: dict[str, str] = {}


def _utc_now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z")


# --- sync bridge: one dedicated runner thread owns the MCP event loop ---
_RUNNER_THREAD: threading.Thread | None = None
_RUNNER_LOOP: asyncio.AbstractEventLoop | None = None


def _runner_loop() -> asyncio.AbstractEventLoop:
    global _RUNNER_THREAD, _RUNNER_LOOP
    with _SESSION_LOCK:
        if _RUNNER_LOOP is not None:
            return _RUNNER_LOOP
        loop: asyncio.AbstractEventLoop = asyncio.new_event_loop()
        ready = threading.Event()

        def _run() -> None:
            asyncio.set_event_loop(loop)
            ready.set()
            loop.run_forever()

        t = threading.Thread(target=_run, name="mcp-runner", daemon=True)
        t.start()
        ready.wait()
        _RUNNER_THREAD = t
        _RUNNER_LOOP = loop
        return loop


def _await(coro: Any, timeout: float = _MCP_TIMEOUT_S) -> Any:
    loop = _runner_loop()
    fut = asyncio.run_coroutine_threadsafe(coro, loop)
    return fut.result(timeout)


def _dashboard_target() -> tuple[str, int]:
    try:
        data = json.loads(Path("engine/rag/corpus/CORPUS.json").read_text(encoding="utf-8"))
        return str(data.get("dashboard_uid", "cineops-render-queue")), int(data.get("panel_id", 1))
    except Exception:
        return "cineops-render-queue", 1


_CORPUS_CACHE: dict | None = None


def _corpus() -> dict:
    global _CORPUS_CACHE
    if _CORPUS_CACHE is None:
        try:
            _CORPUS_CACHE = json.loads(Path("engine/rag/corpus/CORPUS.json").read_text(encoding="utf-8"))
        except Exception:
            _CORPUS_CACHE = {}
    return _CORPUS_CACHE


def _incident_window() -> tuple[str | None, str | None]:
    try:
        w = _corpus().get("incident_window", {}) or {}
        start, end = w.get("from"), w.get("to")
        if isinstance(start, str) and isinstance(end, str) and start and end:
            return start, end
    except Exception:
        pass
    return None, None


_DS_UID_CACHE: dict[str, str] = {}


def _datasource_uid(session: Any, ds_type: str) -> str | None:
    """Default datasource UID for a type (E2E F14): prefer the flagged default,
    else the first of that type. Cached per process."""
    if ds_type in _DS_UID_CACHE:
        return _DS_UID_CACHE[ds_type]
    try:
        result = session.call_tool("list_datasources", {})
        rows, is_error = _parse_rows(result)
        cands: list[dict] = []
        for r in rows:
            if not isinstance(r, dict):
                continue
            for d in r.get("datasources", []) if isinstance(r.get("datasources"), list) else [r]:
                if isinstance(d, dict) and str(d.get("type", "")).lower() == ds_type.lower() and d.get("uid"):
                    cands.append(d)
        if not cands:
            return None
        # Prefer the real production store: Grafana Cloud ships auxiliary
        # stores of the same type (e.g. a loki-type
        # "grafanacloud-alert-state-history" datasource). Querying production
        # logs against the alert-history store returns rows without shot_id,
        # so R-FAILRUN silently never fires. Deprioritize alert/history/state
        # stores; prefer the default, then alphabetical.
        def _rank(d: dict) -> tuple:
            name = str(d.get("name", "")).lower()
            is_aux = any(k in name for k in ("alert", "history", "state"))
            return (is_aux, not bool(d.get("isDefault")), name)

        cands.sort(key=_rank)
        uid = str(cands[0]["uid"])
        _DS_UID_CACHE[ds_type] = uid
        return uid
    except Exception:
        return None


def _adapt_args(tool: str, kind: str, args: dict, session: Any) -> dict:
    """Translate plan-level args to the discovered tool's schema (E2E F14).

    QueryPlans carry a provider-neutral `query` key; the real tools want
    `expr` (Prometheus) / `logql` (Loki). Missing datasource + time bounds
    default to the corpus incident window so window-scoped demo evidence
    works out of the box; explicit caller values always win.
    """
    args = dict(args or {})
    start, end = _incident_window()
    if kind == "metrics":
        if "expr" not in args and "query" in args:
            args["expr"] = args.pop("query")
        if "datasourceUid" not in args:
            uid = _datasource_uid(session, "prometheus")
            if uid:
                args["datasourceUid"] = uid
        if "expr" in args and "startTime" not in args and "endTime" not in args and start and end:
            args["startTime"], args["endTime"] = start, end
            args.setdefault("stepSeconds", 60)
            args.setdefault("queryType", "range")
    elif kind == "logs":
        if "logql" not in args and "query" in args:
            args["logql"] = args.pop("query")
        if "datasourceUid" not in args:
            uid = _datasource_uid(session, "loki")
            if uid:
                args["datasourceUid"] = uid
        if "logql" in args and "startRfc3339" not in args and "endRfc3339" not in args and start and end:
            args["startRfc3339"], args["endRfc3339"] = start, end
    elif kind == "dashboards":
        # search_dashboards accepts ONLY query/limit/page
        # (additionalProperties:false): the planner echoes uid/production
        # from the inventory block into step args, and the server answers
        # those with isError (Bug 1: every run degraded on this one call).
        # Strip to the accepted keys; default the query to the corpus
        # dashboard uid so the call stays meaningful.
        clean: dict = {}
        query = args.get("query")
        if isinstance(query, str) and query.strip():
            clean["query"] = query
        else:
            uid, _panel = _dashboard_target()
            clean["query"] = uid
        if "limit" in args:
            clean["limit"] = args["limit"]
        if "page" in args:
            clean["page"] = args["page"]
        return clean
    return args


def _child_env() -> dict[str, str]:
    # Minimal child env WITHOUT reading os.environ as a mapping (DP-GUARD owns
    # env reads; the §8 reviewer grep forbids the literal `os.environ` here).
    path_val = os.getenv("PATH", "") or os.defpath
    env: dict[str, str] = {
        "PATH": path_val,
        "GRAFANA_URL": settings.grafana_stack_url,
        "GRAFANA_SERVICE_ACCOUNT_TOKEN": settings.grafana_service_account_token,
    }
    systemroot = os.getenv("SystemRoot")
    if systemroot:
        env["SystemRoot"] = systemroot
    return env


try:  # mcp 2.x vendors its HTTP stack as httpx2; mcp 1.x uses httpx.
    import httpx2 as _httpx_mod  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    import httpx as _httpx_mod  # type: ignore[no-redef]


async def _connect_http() -> tuple[Any, ...]:
    headers = {
        "X-Grafana-URL": settings.grafana_stack_url,
        "Authorization": "Bearer <oauth-2.1-access-token>",
    }
    # mcp>=2 removed the headers/timeout kwargs: auth rides on the httpx
    # client passed as http_client (same shape in mcp 1.x).
    http_client = _httpx_mod.AsyncClient(headers=headers, timeout=_httpx_mod.Timeout(_MCP_TIMEOUT_S))
    try:
        cm = streamable_http_client(settings.grafana_mcp_url, http_client=http_client)
    except Exception:
        with contextlib.suppress(Exception):
            await http_client.aclose()
        raise
    entered = await cm.__aenter__()
    try:
        # mcp 1.x yields (read, write, getSessionId); mcp 2.x yields (read, write).
        if len(entered) == 3:
            read, write, _get_id = entered
        else:
            read, write = entered
        session = ClientSession(read, write)
        await session.__aenter__()
        try:
            await asyncio.wait_for(session.initialize(), timeout=_MCP_TIMEOUT_S)
        except Exception:
            await session.__aexit__(None, None, None)
            raise
        return (cm, session, read, write, http_client)
    except Exception:
        await cm.__aexit__(None, None, None)
        with contextlib.suppress(Exception):
            await http_client.aclose()
        raise
        return (cm, session, read, write)
    except Exception:
        await cm.__aexit__(None, None, None)
        raise


async def _connect_stdio() -> tuple[Any, Any, Any, Any]:
    params = StdioServerParameters(
        # settings.grafana_mcp_bin defaults to a bare "mcp-grafana" (PATH
        # lookup) and is overridable with MCP_GRAFANA_BIN. Without it the
        # server silently reports grafana-mcp unreachable whenever the launcher
        # shell's PATH differs from the operator's (E2E F19).
        command=settings.grafana_mcp_bin,
        args=["--disable-write=false"],
        env=_child_env(),
    )
    cm = stdio_client(params)
    entered = await cm.__aenter__()
    try:
        read, write = entered
        session = ClientSession(read, write)
        await session.__aenter__()
        try:
            await asyncio.wait_for(session.initialize(), timeout=_MCP_TIMEOUT_S)
        except Exception:
            await session.__aexit__(None, None, None)
            raise
        return (cm, session, read, write)
    except Exception:
        await cm.__aexit__(None, None, None)
        raise


def _is_headless_oauth_failure(exc: BaseException) -> bool:
    msg = f"{type(exc).__name__}: {exc}".lower()
    return any(k in msg for k in ("oauth", "browser", "redirect", "consent", "interaction_required"))


async def _disconnect_async() -> None:
    global _SESSION
    state = _SESSION
    _SESSION = None
    if state is None:
        return
    cm, session = state[0], state[1]
    with contextlib.suppress(Exception):
        await session.__aexit__(None, None, None)
    with contextlib.suppress(Exception):
        await cm.__aexit__(None, None, None)
    if len(state) > 4 and state[4] is not None:
        with contextlib.suppress(Exception):
            await state[4].aclose()


async def _ensure_async(transport: str) -> ClientSession:
    global _SESSION, _PINNED_TRANSPORT
    if _SESSION is not None:
        return _SESSION[1]
    last: BaseException | None = None
    for attempt in range(2):  # initial + exactly one restart
        if _SESSION is not None:
            return _SESSION[1]
        try:
            if transport == "stdio":
                conn = await _connect_stdio()
                pinned = "stdio"
            else:
                conn = await _connect_http()
                pinned = "http"
            _SESSION = conn
            _PINNED_TRANSPORT = pinned
            return conn[1]
        except Exception as exc:
            last = exc
            with contextlib.suppress(Exception):
                await _disconnect_async()
            if attempt == 0 and transport == "auto":
                # Auto leg 2: stdio fallback (timeout or headless OAuth).
                if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or _is_headless_oauth_failure(exc):
                    try:
                        conn = await _connect_stdio()
                        _SESSION = conn
                        _PINNED_TRANSPORT = "stdio"
                        return conn[1]
                    except Exception as exc2:
                        last = exc2
                        with contextlib.suppress(Exception):
                            await _disconnect_async()
                        break
                break
            # Pinned transports: the loop's second iteration IS the one restart.
    raise RuntimeError(f"mcp connect failed: {last}") from last


def _ensure_connected() -> ClientSession:
    t = settings.grafana_transport
    transport = t if t in ("http", "stdio", "auto") else "auto"
    if transport == "http":
        pinned = "http"
    elif transport == "stdio":
        pinned = "stdio"
    else:
        pinned = "auto"
    return _await(_ensure_async(pinned), timeout=_MCP_TIMEOUT_S + 5.0)


class _SyncSession:
    def __init__(self, session: ClientSession) -> None:
        self._session = session

    def call_tool(self, tool: str, args: dict) -> Any:
        return _await(self._session.call_tool(tool, args), timeout=_MCP_TIMEOUT_S + 5.0)

    def list_tools(self) -> Any:
        return _await(self._session.list_tools(), timeout=_MCP_TIMEOUT_S + 5.0)


@contextmanager
def mcp_session() -> Iterator[Any]:
    session = _ensure_connected()
    yield _SyncSession(session)


_RESOLUTION_ORDER: list[tuple[str, list[str], list[str]]] = [
    ("metrics", ["query_prometheus", "prometheus"], ["query metrics"]),
    ("logs", ["query_loki_logs", "loki"], ["query logs"]),
    ("traces", ["tempo", "trace"], ["traces"]),
    ("dashboards", ["search_dashboards", "dashboard"], ["search dashboards"]),
    ("alerts", ["list_alert_rules", "alert"], ["alert rules"]),
    ("incidents", ["list_incidents", "incident"], ["incidents"]),
    ("annotation", ["create_annotation", "annotation"], ["create annotation"]),
    ("incident-note", ["add_activity", "incident"], ["note", "comment"]),
]


def mcp_tool_names() -> list[str]:
    global _TOOL_CACHE, _SCHEMA_CACHE
    if _TOOL_CACHE is not None:
        return list(_TOOL_CACHE)
    with mcp_session() as session:
        tools = session.list_tools()
        entries = list(tools.tools)
        names = [t.name for t in entries]
        schemas = {t.name: dict(t.inputSchema or {}) for t in entries}
        for t in entries:
            _DESC_CACHE[t.name] = str(getattr(t, "description", "") or "")
        _TOOL_CACHE = names
        _SCHEMA_CACHE = schemas
        _write_tools_md(names)
        return list(names)


def _write_tools_md(names: list[str]) -> None:
    lines = [
        "# Grafana MCP tools (discovered " + _utc_now_iso() + ")",
        f"- transport: {_PINNED_TRANSPORT} (pinned; settings.grafana_transport={settings.grafana_transport})",
        f"- endpoint: {settings.grafana_mcp_url}",
        f"- stack: {settings.grafana_stack_url}",
        f"- tool_count: {len(names)}",
        "## tools",
    ]
    for name in names:
        desc = _DESC_CACHE.get(name, "")
        schema = json.dumps((_SCHEMA_CACHE or {}).get(name, {}), sort_keys=True, default=str)
        lines.append(f"- `{name}`: `{desc[:160]}` input: `{schema[:500]}`")
    lines.append("## resolution")
    kinds = ["metrics", "logs", "traces", "dashboards", "alerts", "incidents", "annotation", "incident-note"]
    parts = []
    for kind in kinds:
        hit = resolve_tool(kind)
        parts.append(f"{kind} -> `{hit if hit else 'none(rest-fallback)'}`")
    lines.append("- " + "; ".join(parts[:6]) + ";")
    lines.append("- " + "; ".join(parts[6:]))
    Path("engine/mcp/TOOLS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")


def resolve_tool(kind: str) -> str | None:
    names = list(_TOOL_CACHE) if _TOOL_CACHE is not None else []
    order = next((o for o in _RESOLUTION_ORDER if o[0] == kind), None)
    if order is None:
        return None
    _, name_subs, desc_keys = order
    lowered = {n: n.lower() for n in names}
    for sub in name_subs:
        for name, low in lowered.items():
            if sub.lower() in low:
                return name
    for key in desc_keys:
        for name in names:
            if key.lower() in _DESC_CACHE.get(name, "").lower():
                return name
    return None


def _parse_rows(result: Any) -> tuple[list[dict], bool]:
    if getattr(result, "isError", False):
        return [], True
    blocks = list(getattr(result, "content", None) or [])
    structured: Any = getattr(result, "structuredContent", None)
    if structured is not None:
        return _coerce_payload(structured), False
    rows: list[dict] = []
    for block in blocks:
        btype = getattr(block, "type", "")
        text = getattr(block, "text", None)
        data = getattr(block, "data", None)
        if btype == "json" or (data is not None and text is None):
            payload = data if data is not None else None
            if payload is not None:
                rows.extend(_coerce_payload(payload))
                continue
        if isinstance(text, str):
            stripped = text.strip()
            if stripped.startswith(("{", "[")):
                try:
                    rows.extend(_coerce_payload(json.loads(stripped)))
                    continue
                except Exception:
                    pass
            table_rows = _parse_table_text(stripped)
            if table_rows is not None:
                rows.extend(table_rows)
            else:
                rows.append({"text": text})
        elif text is not None:
            rows.append({"text": str(text)})
    return rows, False


def _coerce_payload(payload: Any) -> list[dict]:
    if isinstance(payload, list):
        return [p if isinstance(p, dict) else {"value": p} for p in payload]
    if isinstance(payload, dict):
        for key in ("rows", "results", "values"):
            val = payload.get(key)
            if isinstance(val, list):
                return [p if isinstance(p, dict) else {"value": p} for p in val]
        return [payload]
    return [{"value": payload}]


def _parse_table_text(text: str) -> list[dict] | None:
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if len(lines) < 2:
        return None
    import re

    def split_row(ln: str) -> list[str]:
        ln = ln.strip().strip("|")
        if "|" in ln:
            return [c.strip() for c in ln.split("|")]
        return re.split(r"\s{2,}", ln.strip())

    headers = split_row(lines[0])
    if len(headers) < 2:
        return None
    out: list[dict] = []
    for ln in lines[1:]:
        if set(ln.strip()) <= set("|-: "):
            continue
        cells = split_row(ln)
        if len(cells) != len(headers):
            continue
        out.append(dict(zip(headers, cells)))
    return out if out else None


def _grafana_link(kind: str) -> str:
    uid, _panel = _dashboard_target()
    root = settings.grafana_stack_url.rstrip("/")
    if kind in ("dashboards", "annotation"):
        return f"{root}/d/{uid}"
    return root


def _append_proof(entry: dict) -> None:
    try:
        path = Path(MCP_PROOF_LOG)
        path.parent.mkdir(parents=True, exist_ok=True)
        line = json.dumps(entry, default=str) + "\n"
        with open(path, "ab") as fh:
            fh.write(line.encode("utf-8"))
            fh.flush()
            os.fsync(fh.fileno())
    except Exception:
        pass


# Inner MCP timeouts reach 20-25 s, above the chassis 15 s default: without a
# per-call budget every slow-but-working MCP call would false-timeout and
# retry wastefully (E2E F11). Chassis defaults untouched.
_MCP_GUARD_CONFIG: dict = {"timeout_ms": 60000, "retries": 1}


def _revive_evidence(value: Any) -> Any:
    """Rehydrate a golden-cache hit (plain dict) back into GrafanaEvidence.

    No-op for live values and for DegradedResults (E2E F18).
    """
    if isinstance(value, dict) and "mcp_tool" in value and "reason" not in value:
        try:
            return GrafanaEvidence.model_validate(value)
        except Exception:
            return value
    return value


@guarded("grafana-mcp-call", provider="grafana", config=_MCP_GUARD_CONFIG, revive=_revive_evidence)
def mcp_call(tool: str, args: dict, *, kind: str) -> Any:
    import hashlib as _hashlib

    t0 = time.monotonic()
    if not tool:
        _append_proof(
            {"ts": _utc_now_iso(), "tool": "", "kind": kind, "args": dict(args or {}), "rows": 0, "ms": 0, "path": "mcp", "ok": False}
        )
        from src.resilience.degraded import make_degraded_result as _mk

        return _mk(reason="mcp_tool_error", fallback_source="none", original_error=f"no tool resolved for kind {kind}")
    with mcp_session() as session:
        adapted = _adapt_args(tool, kind, dict(args or {}), session)
        result = session.call_tool(tool, adapted)
    rows, is_error = _parse_rows(result)
    took_ms = int((time.monotonic() - t0) * 1000)
    if is_error:
        _append_proof(
            {"ts": _utc_now_iso(), "tool": tool, "kind": kind, "args": adapted, "rows": 0, "ms": took_ms, "path": "mcp", "ok": False}
        )
        from src.resilience.degraded import make_degraded_result as _mk2

        return _mk2(reason="mcp_tool_error", fallback_source="none", original_error=f"tool {tool} returned isError")
    evidence_id = "ev-" + _hashlib.sha1((tool + json.dumps(adapted, sort_keys=True, default=str)).encode("utf-8")).hexdigest()[:12]
    _append_proof(
        {"ts": _utc_now_iso(), "tool": tool, "kind": kind, "args": adapted, "rows": len(rows), "ms": took_ms, "path": "mcp", "ok": True}
    )
    return GrafanaEvidence(
        evidence_id=evidence_id,
        kind=kind,  # type: ignore[arg-type]
        mcp_tool=tool,
        args=dict(args or {}),
        rows=rows,
        row_count=len(rows),
        grafana_link=_grafana_link(kind),
        took_ms=took_ms,
        degraded=False,
        synthetic=False,
    )


@guarded("grafana-mcp-write-annotation", provider="grafana", config=_MCP_GUARD_CONFIG)
def mcp_write_annotation(action: RemediationAction) -> Any:
    uid, panel = _dashboard_target()
    dashboard_uid = action.dashboard_uid or uid
    panel_id = action.panel_id if action.panel_id is not None else panel
    # resolve_tool reads the module-global tool cache, which nothing populates
    # in a bare run process (reads don't list tools): without this refresh
    # every write silently drops to the REST fallback even when the MCP
    # annotation tool exists. Best-effort — a listing failure keeps the
    # fallback, never breaks the write.
    try:
        mcp_tool_names()
    except Exception:
        pass
    tool = resolve_tool("annotation")
    if tool is not None:
        args = {
            "dashboardUid": dashboard_uid,
            "panelId": panel_id,
            "text": action.annotation_text,
            "time": action.time_ms,
        }
        with mcp_session() as session:
            result = session.call_tool(tool, args)
        rows, is_error = _parse_rows(result)
        link = f"{settings.grafana_stack_url.rstrip('/')}/d/{dashboard_uid}"
        if not is_error:
            _append_proof(
                {"ts": _utc_now_iso(), "tool": tool, "kind": "annotation", "args": args, "rows": len(rows), "ms": 0, "path": "mcp", "ok": True}
            )
            remote = None
            if rows and isinstance(rows[0], dict):
                remote = rows[0].get("id", rows[0].get("uid"))
            return WriteReceipt(
                action_id=action.action_id, ok=True, mcp_tool=tool, path="mcp",  # type: ignore[arg-type]
                remote_id=str(remote) if remote is not None else None, grafana_link=link, error=None,
            )
    # REST fallback (§5c).
    import httpx as _httpx

    try:
        resp = _httpx.post(
            f"{settings.grafana_stack_url.rstrip('/')}/api/annotations",
            headers={"Authorization": f"Bearer {settings.grafana_service_account_token}"},
            json={"dashboardUID": dashboard_uid, "panelId": panel_id, "text": action.annotation_text, "time": action.time_ms},
            timeout=_MCP_TIMEOUT_S,
        )
        resp.raise_for_status()
        body = resp.json() if resp.content else {}
        link = f"{settings.grafana_stack_url.rstrip('/')}/d/{dashboard_uid}"
        _append_proof(
            {"ts": _utc_now_iso(), "tool": "rest-annotations", "kind": "annotation", "args": {"dashboardUid": dashboard_uid}, "rows": 1, "ms": 0, "path": "rest-fallback", "ok": True}
        )
        return WriteReceipt(
            action_id=action.action_id, ok=True, mcp_tool="rest-annotations", path="rest-fallback",  # type: ignore[arg-type]
            remote_id=str(body.get("id")) if isinstance(body, dict) and body.get("id") is not None else None,
            grafana_link=link, error=None,
        )
    except Exception as exc:
        _append_proof(
            {"ts": _utc_now_iso(), "tool": "rest-annotations", "kind": "annotation", "args": {}, "rows": 0, "ms": 0, "path": "rest-fallback", "ok": False}
        )
        return WriteReceipt(
            action_id=action.action_id, ok=False, mcp_tool="rest-annotations",
            path="rest-fallback", remote_id=None, grafana_link=None, error=str(exc)[:500],  # type: ignore[arg-type]
        )


@guarded("grafana-mcp-write-note", provider="grafana", config=_MCP_GUARD_CONFIG)
def mcp_write_incident_note(action: RemediationAction) -> Any:
    uid, panel = _dashboard_target()
    dashboard_uid = action.dashboard_uid or uid
    panel_id = action.panel_id if action.panel_id is not None else panel
    # Same tool-cache refresh as mcp_write_annotation (see note there).
    try:
        mcp_tool_names()
    except Exception:
        pass
    tool = resolve_tool("incident-note")
    if tool is not None:
        args = {
            "title": action.target,
            "text": action.annotation_text or action.rationale,
            "dashboardUid": dashboard_uid,
            "panelId": panel_id,
        }
        with mcp_session() as session:
            result = session.call_tool(tool, args)
        rows, is_error = _parse_rows(result)
        link = f"{settings.grafana_stack_url.rstrip('/')}/d/{dashboard_uid}"
        if not is_error:
            _append_proof(
                {"ts": _utc_now_iso(), "tool": tool, "kind": "incident-note", "args": args, "rows": len(rows), "ms": 0, "path": "mcp", "ok": True}
            )
            remote = None
            if rows and isinstance(rows[0], dict):
                remote = rows[0].get("id", rows[0].get("uid"))
            return WriteReceipt(
                action_id=action.action_id, ok=True, mcp_tool=tool, path="mcp",  # type: ignore[arg-type]
                remote_id=str(remote) if remote is not None else None, grafana_link=link, error=None,
            )
    import httpx as _httpx

    try:
        resp = _httpx.post(
            f"{settings.grafana_stack_url.rstrip('/')}/api/annotations",
            headers={"Authorization": f"Bearer {settings.grafana_service_account_token}"},
            json={"text": action.annotation_text or action.rationale, "tags": ["incident-note", action.target]},
            timeout=_MCP_TIMEOUT_S,
        )
        resp.raise_for_status()
        body = resp.json() if resp.content else {}
        link = f"{settings.grafana_stack_url.rstrip('/')}/d/{dashboard_uid}"
        _append_proof(
            {"ts": _utc_now_iso(), "tool": "rest-incident-note", "kind": "incident-note", "args": {"title": action.target}, "rows": 1, "ms": 0, "path": "rest-fallback", "ok": True}
        )
        return WriteReceipt(
            action_id=action.action_id, ok=True, mcp_tool="rest-incident-note", path="rest-fallback",  # type: ignore[arg-type]
            remote_id=str(body.get("id")) if isinstance(body, dict) and body.get("id") is not None else None,
            grafana_link=link, error=None,
        )
    except Exception as exc:
        _append_proof(
            {"ts": _utc_now_iso(), "tool": "rest-incident-note", "kind": "incident-note", "args": {}, "rows": 0, "ms": 0, "path": "rest-fallback", "ok": False}
        )
        return WriteReceipt(
            action_id=action.action_id, ok=False, mcp_tool="rest-incident-note", path="rest-fallback",  # type: ignore[arg-type]
            remote_id=None, grafana_link=None, error=str(exc)[:500],
        )


def mcp_health() -> dict:
    try:
        if settings.forced_degraded:
            return {
                "reachable": False,
                "transport": _PINNED_TRANSPORT or settings.grafana_transport,
                "endpoint": settings.grafana_mcp_url,
                "tool_count": 0,
                "tools": [],
                "stack_url": settings.grafana_stack_url,
                "last_error": "forced_degraded",
            }
        tools = mcp_tool_names()
        return {
            "reachable": True,
            "transport": _PINNED_TRANSPORT,
            "endpoint": settings.grafana_mcp_url,
            "tool_count": len(tools),
            "tools": tools,
            "stack_url": settings.grafana_stack_url,
            "last_error": None,
        }
    except Exception as err:
        return {
            "reachable": False,
            "transport": _PINNED_TRANSPORT or settings.grafana_transport,
            "endpoint": settings.grafana_mcp_url,
            "tool_count": 0,
            "tools": [],
            "stack_url": settings.grafana_stack_url,
            "last_error": str(err)[:500],
        }


__all__ = [
    "MCP_PROOF_LOG",
    "mcp_session",
    "mcp_tool_names",
    "resolve_tool",
    "mcp_call",
    "mcp_write_annotation",
    "mcp_write_incident_note",
    "mcp_health",
]
