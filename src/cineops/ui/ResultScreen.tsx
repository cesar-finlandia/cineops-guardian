// CineOps Guardian — result screen (DP-UI FR-11).
import type { JSX } from "react";
import { useEffect, useState } from "react";
import type {
  CineOpsIncidentFinding,
  CineOpsProductionShot,
  CineOpsRemediationAction,
  CineOpsRunResult,
  CineOpsWriteReceipt,
} from "../types.js";
import type { RunState } from "./App.js";
import { getResult } from "../api.js";
import { FindingRow } from "./components/FindingRow.js";
import { ShotTable } from "./components/ShotTable.js";
import { DegradedBanner } from "./components/DegradedBanner.js";
import { MarkdownReport } from "./components/MarkdownReport.js";

export interface ResultScreenProps {
  state: RunState;
  traceId: string | null;
  onReset: () => void;
}

const CSV_HEADER = "shot_id,production,status,priority,due_at,action,recommended_note";

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

export function ResultScreen(props: ResultScreenProps): JSX.Element {
  const { state, traceId, onReset } = props;
  const [full, setFull] = useState<CineOpsRunResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    if (!traceId) return;
    try {
      const res = await getResult(traceId);
      if ("trace_id" in res) setFull(res as CineOpsRunResult);
      else setNotice("Result not ready yet — still streaming.");
    } catch {
      setNotice("Result not ready yet — still streaming.");
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [traceId]);

  const unsorted: CineOpsIncidentFinding[] = full ? full.findings : state.findings;
  // Blockers first so Maya sees what prevents dailies without scrolling
  // through healthy shots. Healthy (ok) findings collapse behind <details>.
  const RANK: Record<string, number> = { blocked: 0, high: 1, medium: 2, low: 3, ok: 4 };
  const findings: CineOpsIncidentFinding[] = [...unsorted].sort(
    (a, b) => (RANK[a.level] ?? 5) - (RANK[b.level] ?? 5) || String(a.shot_id ?? "").localeCompare(String(b.shot_id ?? "")),
  );
  const actionable = findings.filter((f) => f.level !== "ok");
  const healthy = findings.filter((f) => f.level === "ok");
  const actions: CineOpsRemediationAction[] = full ? full.actions : state.actions;
  const receipts: CineOpsWriteReceipt[] = full ? full.receipts : state.receipts;
  const hoursSaved = full ? full.totals.hours_saved : state.totals.hours_saved;
  const revised: CineOpsProductionShot[] = full ? full.revised_shots : [];

  const downloadCsv = (): void => {
    // The button must always work: when remediation actions exist, export the
    // action plan; when nothing was actionable, export the full revised shot
    // table instead of a disabled dead-end.
    const rows =
      actions.length > 0
        ? actions.map((a) => {
            const shot = revised.find((s) => s.shot_id === a.target);
            return [
              a.target,
              shot ? shot.production : "",
              shot ? shot.status : "",
              shot ? String(shot.priority) : a.new_priority === null || a.new_priority === undefined ? "" : String(a.new_priority),
              shot ? shot.due_at : "",
              a.kind,
              a.rationale,
            ]
              .map(csvEscape)
              .join(",");
          })
        : revised.map((s) =>
            [s.shot_id, s.production, s.status, String(s.priority), s.due_at, "", ""].map(csvEscape).join(","),
          );
    const csv = [CSV_HEADER, ...rows].join("\n") + "\n";
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const short = (traceId ?? "run").slice(0, 8);
    a.href = url;
    a.download = `revised-schedule-${short}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="cineops-result" data-screen="result">
      <DegradedBanner visible={state.degraded} reason={state.degradedReason} details={state.degradedSteps} />
      {notice ? (
        <p>
          {notice} <button onClick={() => void refresh()}>Retry</button>
        </p>
      ) : null}
      <div className="cg-hero">
        <p className="cg-eyebrow">Dailies ready · {findings.length} findings</p>
        <h2>Blocked shots, explained — with the fix</h2>
        <p className="cg-lede">{state.summary ? state.summary.slice(0, 220) : "Revised shot order with citations and Grafana write-back below."}</p>
      </div>
      <div className="cg-totals">
        <div className="cg-total">
          <div className="cg-total-num">{findings.filter((f) => f.level === "blocked").length}</div>
          <div className="cg-total-label">Blocked</div>
        </div>
        <div className="cg-total">
          <div className="cg-total-num">{findings.filter((f) => f.level === "high").length}</div>
          <div className="cg-total-label">High</div>
        </div>
        <div className="cg-total">
          <div className="cg-total-num">{receipts.filter((r) => r.ok).length}</div>
          <div className="cg-total-label">Writes applied</div>
        </div>
      </div>
      <h2>
        Findings needing action ({actionable.length})
      </h2>
      {actionable.length === 0 ? (
        <p>Nothing blocking dailies at the selected severity floor — all findings are healthy.</p>
      ) : (
        actionable.map((f) => <FindingRow key={f.finding_id} finding={f} />)
      )}
      {healthy.length > 0 ? (
        <details>
          <summary>Healthy shots ({healthy.length}) — no action needed</summary>
          {healthy.map((f) => (
            <FindingRow key={f.finding_id} finding={f} />
          ))}
        </details>
      ) : null}
      <h2>Writes applied</h2>
      {receipts.map((r) => (
        <p key={r.action_id}>
          {r.action_id}: {r.ok ? "written" : "failed"} via {r.mcp_tool} (path: {r.path})
          {r.grafana_link ? (
            <a href={r.grafana_link} data-testid="grafana-link">
              Open in Grafana
            </a>
          ) : null}
        </p>
      ))}
      <p data-testid="hours-saved">Hours saved: {hoursSaved}</p>
      <h2>Revised schedule — render ⛔ rows first</h2>
      <ShotTable
        shots={revised}
        blockedIds={findings.filter((f) => f.level === "blocked" || f.level === "high").map((f) => String(f.shot_id ?? ""))}
      />
      <button
        data-testid="csv-download"
        disabled={revised.length === 0 && actions.length === 0}
        title={
          actions.length > 0
            ? `Export ${actions.length} remediation actions`
            : revised.length > 0
              ? `No blockers — export full revised table (${revised.length} shots)`
              : "Result not ready yet"
        }
        onClick={downloadCsv}
      >
        Download revised schedule CSV
      </button>
      <h2>Diagnosis report</h2>
      <MarkdownReport markdown={state.summary} />
      <button onClick={onReset}>Back to ingest</button>
    </section>
  );
}
