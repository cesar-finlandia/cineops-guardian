// CineOps Guardian — finding row with citations.
import type { JSX } from "react";
import type { CineOpsIncidentFinding } from "../../types.js";
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";
import { CitationDisplay } from "src/platform/ui/index.js";

export interface FindingRowProps {
  finding: CineOpsIncidentFinding;
}

export function FindingRow(props: FindingRowProps): JSX.Element {
  const { finding } = props;
  const citationEnvelopes = [
    ...finding.evidence_ids.map(
      (id, i) =>
        ({
          step_id: "correlate-evidence",
          status: "done",
          payload: { citations: [{ title: id }] },
          timestamp: "2026-09-04T16:30:00Z",
          sequence: i,
        }) as EventEnvelope,
    ),
    ...finding.commitment_ids.map(
      (id, i) =>
        ({
          step_id: "correlate-evidence",
          status: "done",
          payload: { citations: [{ title: id }] },
          timestamp: "2026-09-04T16:30:00Z",
          sequence: 1000 + i,
        }) as EventEnvelope,
    ),
  ];
  return (
    <article className="cineops-finding-row">
      <header>
        <strong>{finding.finding_id}</strong>
        <span>shot: {finding.shot_id ?? "—"}</span>
        <span>level: {finding.level}</span>
        <span>rules: {finding.rule_ids.join(", ")}</span>
      </header>
      <ul>
        {finding.reasons.map((r, i) => (
          <li key={i}>{r}</li>
        ))}
      </ul>
      <CitationDisplay envelopes={citationEnvelopes} />
    </article>
  );
}
