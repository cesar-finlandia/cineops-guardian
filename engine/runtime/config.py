from __future__ import annotations
import os
import sys
from dataclasses import dataclass

def _str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return default if v is None or not v.strip() else v.strip()

def _posfloat(name: str, default: float) -> float:
    try:
        raw = (os.environ.get(name, "") or "").strip()
        val = float(raw) if raw else default
        return val if val > 0 else default
    except (ValueError, AttributeError):
        return default

def _temp(name: str, default: float) -> float:
    try:
        raw = (os.environ.get(name, "") or "").strip()
        return float(raw) if raw else default
    except (ValueError, AttributeError):
        return default

def _bool01(name: str) -> bool:
    return (os.environ.get(name, "") or "").strip().lower() in ("1", "true", "yes")

@dataclass(frozen=True)
class Settings:
    gcp_project: str = ""
    gcp_location: str = ""
    gemini_model: str = "gemini-2.0-flash"
    gemini_temperature: float = 0.0
    bq_dataset: str = "cineops"
    grafana_mcp_url: str = ""
    grafana_stack_url: str = ""
    grafana_service_account_token: str = ""
    grafana_transport: str = "auto"
    forced_degraded: bool = False
    cost_budget_usd: float = 100.0
    mcp_proof_log: str = "logs/mcp-grafana.jsonl"
    api_base: str = ""

def _load_settings() -> Settings:
    if (os.environ.get("GOOGLE_GENAI_USE_VERTEXAI", "") or "").strip().lower() not in ("", "true", "1"):
        print("[guard] warn: GOOGLE_GENAI_USE_VERTEXAI is not 'true'; Vertex AI mode expected", file=sys.stderr)
    t = _str("GRAFANA_TRANSPORT", "auto").lower()
    return Settings(
        gcp_project=_str("GOOGLE_CLOUD_PROJECT", ""),
        gcp_location=_str("GOOGLE_CLOUD_LOCATION", ""),
        gemini_model=_str("GEMINI_MODEL", "gemini-2.0-flash"),
        gemini_temperature=_temp("GEMINI_TEMPERATURE", 0.0),
        bq_dataset=_str("BQ_DATASET", "cineops"),
        grafana_mcp_url=_str("GRAFANA_MCP_URL", ""),
        grafana_stack_url=_str("GRAFANA_STACK_URL", ""),
        grafana_service_account_token=_str("GRAFANA_SERVICE_ACCOUNT_TOKEN", ""),
        grafana_transport=t if t in ("http", "stdio", "auto") else "auto",
        forced_degraded=_bool01("RES_FORCED_DEGRADED"),
        cost_budget_usd=_posfloat("COST_BUDGET_USD", 100.0),
        mcp_proof_log="logs/mcp-grafana.jsonl",
        api_base=_str("API_BASE", ""),
    )

settings = _load_settings()
