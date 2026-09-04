// CineOps Guardian — backend liveness pill (DP-UI A7). Owns its poll.
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { getHealth } from "../../api.js";

export interface HealthPillProps {
  ok: boolean | null;
  label: string;
}

interface HealthState {
  ok: boolean | null;
  gemini: string;
  grafana: string;
  bigquery: string;
  raw: string;
}

export function HealthPill(props: HealthPillProps): JSX.Element {
  const { label } = props;
  const [state, setState] = useState<HealthState>({ ok: props.ok, gemini: "unknown", grafana: "unknown", bigquery: "unknown", raw: "" });

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        const g = h.gemini as Record<string, unknown>;
        const m = h.grafana_mcp as Record<string, unknown>;
        const b = h.bigquery as Record<string, unknown>;
        setState({
          ok: h.ok,
          gemini: g["reachable"] === true ? "ok" : "unknown",
          grafana: m["reachable"] === true || m["connected"] === true ? "ok" : "unknown",
          bigquery: b["reachable"] === true ? "ok" : "unknown",
          raw: JSON.stringify(h),
        });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, ok: false }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return (
    <span data-testid="health-pill" title={state.raw} className="cineops-health-pill">
      ● {state.ok === null ? "checking" : state.ok ? "healthy" : "degraded"} {label}
      <span> gemini:{state.gemini}</span>
      <span> grafana-mcp:{state.grafana}</span>
      <span> bigquery:{state.bigquery}</span>
    </span>
  );
}
