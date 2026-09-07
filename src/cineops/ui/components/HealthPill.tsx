// CineOps Guardian — backend liveness pill (DP-UI A7). Owns its poll.
//
// Truthfulness contract (Bug 2): every value shown is live probe data, never
// hardcoded. The pill shows WHEN it last checked ("as of HH:MM:SS"), prints
// the failing service's last_error inline (not just hover title), and accepts
// `runIssues` so a green probe that still failed mid-run reads e.g.
// "grafana-mcp: ok/run-failed" instead of a bare "ok".
import type { JSX } from "react";
import { useEffect, useState } from "react";
import { getHealth } from "../../api.js";

export interface HealthPillProps {
  ok: boolean | null;
  label: string;
  /** Service keys ("gemini" | "grafana-mcp" | "bigquery") that degraded in the current/last run. */
  runIssues?: string[];
}

interface HealthState {
  ok: boolean | null;
  gemini: string;
  grafana: string;
  bigquery: string;
  issues: string;
  checkedAt: string;
  raw: string;
}

const INITIAL: HealthState = {
  ok: null,
  gemini: "unknown",
  grafana: "unknown",
  bigquery: "unknown",
  issues: "",
  checkedAt: "",
  raw: "",
};

function errOf(obj: unknown): string {
  if (typeof obj !== "object" || obj === null) return "";
  const e = (obj as Record<string, unknown>)["last_error"];
  return typeof e === "string" ? e.slice(0, 90) : "";
}

function clockNow(): string {
  try {
    return new Date().toLocaleTimeString();
  } catch {
    return "";
  }
}

export function HealthPill(props: HealthPillProps): JSX.Element {
  const { label, runIssues = [] } = props;
  const [state, setState] = useState<HealthState>({ ...INITIAL, ok: props.ok });

  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const h = await getHealth();
        if (cancelled) return;
        const g = h.gemini as Record<string, unknown>;
        const m = h.grafana_mcp as Record<string, unknown>;
        const b = h.bigquery as Record<string, unknown>;
        const gemini = g["reachable"] === true ? "ok" : "unknown";
        const grafana = m["reachable"] === true || m["connected"] === true ? "ok" : "unknown";
        const bigquery = b["reachable"] === true ? "ok" : "unknown";
        const problems: string[] = [];
        if (gemini !== "ok") problems.push("gemini: " + (errOf(h.gemini) || "unreachable"));
        if (grafana !== "ok") problems.push("grafana-mcp: " + (errOf(h.grafana_mcp) || "unreachable"));
        if (bigquery !== "ok") problems.push("bigquery: " + (errOf(h.bigquery) || "unreachable"));
        setState({
          ok: h.ok,
          gemini,
          grafana,
          bigquery,
          issues: problems.join(" · "),
          checkedAt: clockNow(),
          raw: JSON.stringify(h),
        });
      } catch {
        if (!cancelled)
          setState((prev) => ({ ...prev, ok: false, issues: "health fetch failed", checkedAt: clockNow() }));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const withRun = (key: string, probe: string): string =>
    runIssues.includes(key) && probe === "ok" ? probe + "/run-failed" : probe;

  return (
    <span data-testid="health-pill" title={state.raw} className="cineops-health-pill">
      ● {state.ok === null ? "checking" : state.ok ? "healthy" : "degraded"} {label}
      {state.checkedAt ? <span> · as of {state.checkedAt}</span> : null}
      <span> gemini:{withRun("gemini", state.gemini)}</span>
      <span> grafana-mcp:{withRun("grafana-mcp", state.grafana)}</span>
      <span> bigquery:{withRun("bigquery", state.bigquery)}</span>
      {state.issues ? <span className="cg-health-issues"> ({state.issues})</span> : null}
    </span>
  );
}
