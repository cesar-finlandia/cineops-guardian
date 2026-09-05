// CineOps Guardian — degraded banner (never dismissible mid-run).
// Shows WHAT degraded: one row per affected step with its cause, so Maya
// never sees a bare "degraded fallback" with no indication of what failed.
import type { JSX } from "react";

export interface DegradedStep {
  step: string;
  cause: string;
}

export interface DegradedBannerProps {
  visible: boolean;
  reason: string;
  details?: DegradedStep[];
}

// Human titles for the 8 fixed STEP_IDS (mirrors the RunLoader verbs).
const STEP_TITLES: Record<string, string> = {
  "load-context": "Loading production context",
  "plan-queries": "Planning Grafana queries",
  "query-grafana": "Querying Grafana MCP",
  "persist-snapshot": "Persisting snapshot",
  "correlate-evidence": "Correlating evidence",
  "propose-remediation": "Proposing remediation",
  "write-back": "Writing annotation",
  "summarize-run": "Summarizing run",
};

export function DegradedBanner(props: DegradedBannerProps): JSX.Element | null {
  const { visible, reason, details = [] } = props;
  if (!visible) return null;
  return (
    <div data-testid="degraded-banner" role="status" className="cineops-degraded-banner">
      <span>Degraded: {reason} — showing fallback evidence.</span>
      {details.length > 0 ? (
        <ul className="cg-degraded-details">
          {details.map((d) => (
            <li key={d.step}>
              <strong>{STEP_TITLES[d.step] ?? d.step}</strong>
              {d.cause ? <span> — {d.cause}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
