# CineOps Guardian — HTTP seam (DP-API §3.4). Owns the HTTP surface and nothing else.
from __future__ import annotations

import asyncio
import logging
import threading
import uuid
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from src.platform.transport.stream_router import router as stream_router

from engine.api.events import make_publisher, recent_envelopes
from engine.api.sessions import APPROVAL_TIMEOUT_SEC, SESSIONS, HttpApprovalGate, get_session, release
from engine.bq.loader import bq_health, ensure_dataset, load_corpus
from engine.mcp.grafana_mcp import mcp_health
from engine.providers.gemini import gemini_health
from engine.runtime.config import settings
from engine.runtime.guard import cost_snapshot
from engine.schema.domain import RunRequest

UPLOAD_ROOT = Path("/tmp/cineops/uploads")
ALLOWED_UPLOAD_SUFFIXES = {".csv", ".pdf"}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024

app = FastAPI(title="CineOps Guardian")
app.include_router(stream_router)  # GET /events/stream (chassis-owned; mounted, never re-implemented)


class ApproveBody(BaseModel):
    trace_id: str
    action_ids: list[str] = []


class SeedBody(BaseModel):
    production: str
    refresh: bool = False


async def _run_task(trace_id: str, request: RunRequest) -> None:
    publish = make_publisher(trace_id)
    gate = HttpApprovalGate()
    try:
        # Deferred import: engine.agents.agent (DP-AGENT) lands in the next
        # commit; importing at call time keeps this module importable now.
        from engine.agents.agent import run_diagnosis

        result = await run_diagnosis(request, publish, gate)
        SESSIONS[trace_id]["result"] = result
        SESSIONS[trace_id]["status"] = "done"
    except Exception as exc:  # never leave the UI hanging (§6 FM-04)
        SESSIONS[trace_id]["status"] = "error"
        SESSIONS[trace_id]["result"] = None
        try:
            await publish("summarize-run", "error", {"error": str(exc)})
        except Exception:
            pass


def _run_in_worker(trace_id: str, request: RunRequest, server_loop: asyncio.AbstractEventLoop) -> None:
    """Drive the agent on a dedicated worker thread.

    NFR-01/NFR-05: run_diagnosis performs minutes of synchronous blocking I/O
    (Gemini/BigQuery/MCP SDK calls with no asyncio yield points). Running it
    as a loop task starves the server loop — pending response bodies never
    flush, SSE stalls, /api/health stalls, and the browser sees a hung app
    (E2E F10). The worker thread owns a private loop (asyncio.run); the two
    loop-bound seams are bridged back with run_coroutine_threadsafe:
    EventEnvelope publish (SSE fanout queues live on the server loop) and the
    approval gate (its asyncio.Event + timeouts live on the server loop).
    """
    server_publish = make_publisher(trace_id)
    gate = HttpApprovalGate()

    async def threadsafe_publish(step_id: str, status: str, payload: dict, *, degraded: bool = False) -> None:
        fut = asyncio.run_coroutine_threadsafe(
            server_publish(step_id, status, payload, degraded=degraded), server_loop
        )
        await asyncio.wrap_future(fut)

    class _ThreadGate:
        async def wait(self, trace_id_: str, actions: list) -> list[str]:
            fut = asyncio.run_coroutine_threadsafe(gate.wait(trace_id_, actions), server_loop)
            return await asyncio.wait_for(
                asyncio.wrap_future(fut), timeout=APPROVAL_TIMEOUT_SEC + 30.0
            )

    async def _main() -> None:
        try:
            from engine.agents.agent import run_diagnosis

            result = await run_diagnosis(request, threadsafe_publish, _ThreadGate())  # type: ignore[arg-type]
            SESSIONS[trace_id]["result"] = result
            SESSIONS[trace_id]["status"] = "done"
        except Exception as exc:  # never leave the UI hanging (§6 FM-04)
            SESSIONS[trace_id]["status"] = "error"
            SESSIONS[trace_id]["result"] = None
            try:
                await threadsafe_publish("summarize-run", "error", {"error": str(exc)})
            except Exception:
                pass

    asyncio.run(_main())


@app.post("/api/run")
async def post_run(body: RunRequest) -> dict:
    trace_id = body.trace_id or str(uuid.uuid4())
    SESSIONS[trace_id] = {
        "status": "running",
        "result": None,
        "actions": [],
        "event": asyncio.Event(),
        "approved": [],
    }
    request = body.model_copy(update={"trace_id": trace_id})
    # Worker thread (not BackgroundTasks): the agent blocks synchronously, so
    # a loop task would hold the response body + SSE + health hostage (F10).
    server_loop = asyncio.get_running_loop()
    threading.Thread(
        target=_run_in_worker, args=(trace_id, request, server_loop), daemon=True
    ).start()
    return {"trace_id": trace_id}


@app.post("/api/approve")
async def post_approve(body: ApproveBody) -> dict:
    try:
        released = release(body.trace_id, list(body.action_ids))
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown trace_id")
    return {"released": released}


@app.get("/api/result/{trace_id}")
async def get_result(trace_id: str):
    try:
        session = get_session(trace_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="unknown trace_id")
    if session["status"] == "awaiting-approval":
        return {"status": "awaiting-approval", "actions": [a.model_dump() for a in session["actions"]]}
    if session["result"] is None:
        return {"status": session["status"]}  # "running" or "error" (error detail is on SSE)
    return session["result"]


@app.get("/api/events/recent")
async def get_recent_events(trace_id: str, after: int = -1) -> dict:
    """Replay envelopes published for trace_id with sequence > after (E2E F13).

    Gap insurance for the broadcast-only SSE hub: subscribers that connected
    late or reconnected after the chassis 15 s idle close fetch what they
    missed. Unknown trace_id yields an empty list (never 404: a run may not
    have published anything yet).
    """
    return {"trace_id": trace_id, "envelopes": recent_envelopes(trace_id, after=after)}


# ...continued (same file engine/api/app.py) — copy verbatim.
@app.post("/api/seed")
async def post_seed(body: SeedBody) -> dict:
    # DP-BQ binding signature: load_corpus(corpus_dir, *, production, refresh).
    # refresh=False is the fast ensure path (COUNT check, no reload).
    outcome = load_corpus("engine/rag/corpus", production=body.production, refresh=body.refresh)
    if not isinstance(outcome, dict) or "shots" not in outcome:
        from src.resilience.degraded import is_degraded_result as _is_deg

        reason = outcome.get("reason", "degraded") if isinstance(outcome, dict) else "degraded"
        raise HTTPException(status_code=502, detail=f"seed degraded: {reason}")
    return {
        "shots": outcome["shots"],
        "metrics": outcome["metrics"],
        "refreshed": bool(outcome.get("refreshed", False)),
    }


@app.post("/api/upload")
async def post_upload(trace_id: str = Form(...), files: list[UploadFile] = File(...)) -> dict:
    dest_dir = (UPLOAD_ROOT / trace_id).resolve()
    if UPLOAD_ROOT.resolve() not in dest_dir.parents and dest_dir != UPLOAD_ROOT.resolve():
        raise HTTPException(status_code=400, detail="invalid trace_id")
    dest_dir.mkdir(parents=True, exist_ok=True)
    paths: list[str] = []
    for upload in files:
        name = Path(upload.filename or "").name  # strip directories; no "..", no absolute paths
        if not name or name in {".", ".."} or "/" in (upload.filename or "") or "\\" in (upload.filename or ""):
            raise HTTPException(status_code=400, detail=f"bad filename {upload.filename!r}")
        suffix = Path(name).suffix.lower()
        if suffix not in ALLOWED_UPLOAD_SUFFIXES:
            raise HTTPException(status_code=400, detail=f"extension {suffix!r} not allowed")
        body = await upload.read()
        if len(body) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail=f"file {name!r} exceeds size cap")
        dest = (dest_dir / name).resolve()
        if dest.parent != dest_dir:
            raise HTTPException(status_code=400, detail="path escape")
        dest.write_bytes(body)
        paths.append(str(dest))
    return {"paths": paths}


@app.get("/api/health")
async def get_health() -> dict:
    gemini = gemini_health()
    grafana = mcp_health()
    bigquery = bq_health()
    cost = cost_snapshot()
    gemini_ok = bool(gemini.get("reachable", False))
    bq_ok = bool(bigquery.get("reachable", False))
    # DP-MCP reports `reachable`; accept the DP-API `connected` alias if present.
    grafana_ok = bool(grafana.get("connected", grafana.get("reachable", False)))
    # DP-GUARD reports `over_budget`; accept the `degraded` alias if present.
    cost_degraded = bool(cost.get("over_budget", cost.get("degraded", False)))
    degraded = cost_degraded or not (gemini_ok and bq_ok)
    ok = bool(gemini_ok and bq_ok and grafana_ok)
    return {
        "ok": ok,
        "gemini": gemini,
        "grafana_mcp": grafana,
        "bigquery": bigquery,
        "cost": cost,
        "degraded": degraded,
    }


@app.on_event("startup")
async def _startup() -> None:
    # NFR-01: BigQuery may be unreachable (no ADC off-GCP) and credential /
    # endpoint lookup can stall for tens of seconds. Bound the whole call so
    # boot never blocks: on failure _startup logs and the seam still serves;
    # /api/health reports bigquery.reachable:false and the agent degrades
    # per-step instead.
    try:
        await asyncio.wait_for(asyncio.to_thread(ensure_dataset), timeout=20.0)
    except Exception as exc:  # noqa: BLE001 - startup must never hang the seam
        logging.getLogger("engine.api.app").warning("[startup] ensure_dataset degraded: %s: %s", type(exc).__name__, exc)


def _mount_static() -> None:
    dist = Path(__file__).resolve().parents[2] / "dist"
    if dist.is_dir():
        from fastapi.staticfiles import StaticFiles
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="static")
    # else: development mode without a build — API routes still serve; "/" 404s (see §6 FM-06).


_mount_static()
