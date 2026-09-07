// CineOps Guardian — per-step help popovers (judge support).
// Every timeline row owns a "?" button explaining WHAT that step does and HOW
// TO TELL IT'S WORKING, in plain language. Self-contained; new testids only
// (step-help-<step_id>). Copy must stay honest: approval publishes the record,
// it never fixes a render.
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";

interface StepHelp {
  title: string;
  does: string;
  working: string;
}

export const STEP_HELP: Record<string, StepHelp> = {
  "load-context": {
    title: "Load the world the question is about",
    does: "Reads the 240-shot list (deterministic CSV parse, no AI involved) and the six VFX delivery memos (Gemini reads the PDFs; a committed sidecar stands in if that path fails). Everything downstream reasons over this context.",
    working: "Done when the counts land — 240 shots, 6 commitments. If this fails, the run degrades loudly instead of guessing.",
  },
  "plan-queries": {
    title: "Turn the question into a Grafana query plan",
    does: "Gemini converts Maya's plain-English question into a validated plan of at most 8 typed, time-bounded Grafana operations. If the model path fails, a deterministic 3-step fallback plan is used and flagged as degraded.",
    working: "A plan appears with kinds like metrics, logs, dashboards. Ask a different question on your next run and watch the plan change — proof it is live, not canned.",
  },
  "query-grafana": {
    title: "Run the plan against Grafana through the MCP server",
    does: "Each planned step executes as a real Grafana MCP tool call — query_prometheus for queue latency, query_loki_logs for failed jobs, search_dashboards for the pipeline view, plus alerts and incidents. Every call is appended to logs/mcp-grafana.jsonl and becomes one evidence card.",
    working: "Evidence cards stream in below, each naming its MCP tool, row count, and milliseconds. This row is the track gate, on camera: no cards, no proof.",
  },
  "persist-snapshot": {
    title: "Save the telemetry snapshot to BigQuery",
    does: "The normalised evidence is written to the cineops dataset (evidence_snapshots) so every run is grounded in stored state and trends stay comparable night after night.",
    working: "Done reports a row count and the table name. If BigQuery is unreachable the run continues from local data and says so.",
  },
  "correlate-evidence": {
    title: "Join evidence to shots with pure rules",
    does: "Deterministic Python rules (R-QUEUE, R-FAILRUN, R-FANOUT, R-ALERT, R-INCIDENT, R-STATUS, R-COMMIT, R-TREND, R-PENDING) match telemetry against shots, delivery commitments, and dependencies, and assign each finding its severity. Failed shots always surface (R-STATUS) and overdue commitments count even when past due (R-COMMIT); in-flight shots fall back to R-PENDING instead of vanishing. No model decides a level — Gemini only explains the verdict later.",
    working: "Findings arrive carrying rule ids, human reasons, and citations to the exact evidence and memo entries behind them.",
  },
  "propose-remediation": {
    title: "Draft the fix list and count the hours",
    does: "Computes a recommended new shot order (which jobs should jump the queue for dailies) plus the exact annotation and incident-note texts, each with projected hours saved. Findings below your severity floor are filtered out here.",
    working: "An actions list plus an hours-saved total. Change severity to low and rerun to watch the list grow — the filter is live.",
  },
  "write-back": {
    title: "Write to Grafana — only with your approval",
    does: "Pauses and shows the proposed annotation and incident note. Nothing is written until you approve — and approving does NOT fix any render. It publishes the record: a pinned note on the dashboard panel plus an incident entry, with deep links you can paste to vendors instead of a 4 AM guess.",
    working: "The approval slate appears with one checkbox per action. After Approve, receipts show the tool, the path (mcp), and Open-in-Grafana links.",
  },
  "summarize-run": {
    title: "Write the morning brief",
    does: "Gemini narrates the whole run — findings, totals, hours — into a short summary paragraph. When it lands, the app advances to the Result screen on its own.",
    working: "Summary text streams in then settles; the Result screen opens with findings, receipts, the revised table, and the CSV download.",
  },
};

export function StepHelpButton(props: { step: string }): JSX.Element {
  const { step } = props;
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLSpanElement>(null);
  const help = STEP_HELP[step] ?? { title: step, does: "Runs as part of the 8-step diagnosis.", working: "Its badge turns from pending to done." };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent): void => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open ]);

  return (
    <span className="cg-step-help" ref={boxRef}>
      <button
        type="button"
        className="cg-step-help-btn"
        data-testid={`step-help-${step}`}
        aria-expanded={open}
        aria-label={`What does the ${step} step do?`}
        title={`What does ${step} do?`}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <span className="cg-step-pop" role="dialog" aria-label={`${step}: what this step does`}>
          <strong className="cg-step-pop-title">{help.title}</strong>
          <span className="cg-step-pop-does">{help.does}</span>
          <span className="cg-step-pop-work">How to tell it&apos;s working: {help.working}</span>
          <button type="button" className="cg-step-pop-close" aria-label="Close help" onClick={() => setOpen(false)}>
            ✕
          </button>
        </span>
      ) : null}
    </span>
  );
}
