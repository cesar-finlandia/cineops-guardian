// CineOps Guardian — run screen (DP-UI FR-10 + FR-14).
// NOTE: chassis StepStatusIndicator/StreamingTextRenderer consume envelopes,
// so App additionally passes the raw envelopes via the optional `envelopes`
// prop (additive to the DP-UI literal props; screens never re-subscribe).
import type { JSX } from "react";
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";
import type { StreamStatus } from "src/platform/transport/useEventStream.js";
import { StepStatusIndicator, StreamingTextRenderer } from "src/platform/ui/index.js";
import { STEP_IDS } from "../types.js";
import type { RunState } from "./App.js";
import { EvidenceCard } from "./components/EvidenceCard.js";
import { DegradedBanner } from "./components/DegradedBanner.js";
import { ActionApproval } from "./components/ActionApproval.js";

export interface RunScreenProps {
  state: RunState;
  streamStatus: StreamStatus;
  onApprove: (ids: string[]) => void;
  approving: boolean;
  approved: boolean;
  envelopes?: EventEnvelope[];
  onReconnect?: () => void;
  onReset?: () => void;
  // E2E F13: the replay poller keeps envelopes flowing across chassis SSE
  // idle-closes. While it is alive the run is live even if the socket died,
  // so the scary "Stream error" line stays hidden (Reconnect still offered).
  pollAlive?: boolean;
}

function stepStatus(state: RunState, envelopes: EventEnvelope[], id: string): string {
  const scoped = envelopes.filter((e) => e.step_id === id);
  if (scoped.some((e) => e.status === "done" || e.status === "error")) return "done";
  if (scoped.some((e) => e.status === "started" || e.status === "streaming")) return "running";
  void state;
  return "pending";
}

export function RunScreen(props: RunScreenProps): JSX.Element {
  const { state, streamStatus, onApprove, approving, approved, envelopes = [], onReconnect, onReset, pollAlive = false } = props;

  if (state.status === "error") {
    return (
      <section className="cineops-run" data-screen="run">
        <p>Run failed: {state.error ?? "unknown error"}</p>
        {onReset ? <button onClick={onReset}>Back to ingest</button> : null}
      </section>
    );
  }

  return (
    <section className="cineops-run" data-screen="run">
      <DegradedBanner visible={state.degraded} reason={state.degradedReason} />
      {streamStatus === "connecting" ? <p data-testid="connecting">Connecting to run stream…</p> : null}
      {streamStatus === "error" && !pollAlive ? (
        <p>
          Stream error — retrying…{onReconnect ? <button onClick={onReconnect}>Reconnect</button> : null}
        </p>
      ) : null}
      {/* FR-10: exactly one progress list covering the fixed 8-step run.
          The chassis StepStatusIndicator (read-only, envelope-driven) renders
          the steps the run has reached; the roadmap below appends the steps it
          has not reached yet, which the chassis component cannot know about
          (its status enum has no "pending"). Rendering both lists in full
          duplicated every step on screen and in the DOM (E2E F17) — Maya saw
          the same eight rows twice. One step_id, one row, all eight visible
          from the first second of the run. */}
      <StepStatusIndicator envelopes={envelopes} title="Progress" />
      <ol className="cineops-steps ui-step-status__steps">
        {STEP_IDS.filter((id) => stepStatus(state, envelopes, id) === "pending").map((id) => (
          <li key={id} className="ui-step ui-step--pending" data-step-id={id} data-status="pending">
            <span className="ui-badge ui-badge--pending">pending</span>
            <span className="ui-step__label">{id}</span>
          </li>
        ))}
      </ol>
      <div className="cineops-deltas">
        {STEP_IDS.filter((id) => state.streamDeltas[id]).map((id) => (
          <StreamingTextRenderer key={id} envelopes={envelopes} stepId={id} />
        ))}
      </div>
      <div className="cineops-evidence">
        {state.evidence.map((e, i) => (
          <EvidenceCard
            key={(e.mcp_tool || "ev") + "-" + i}
            mcp_tool={e.mcp_tool}
            kind={e.kind}
            rows={typeof e.rows === "number" ? e.rows : e.rows.length}
            took_ms={e.took_ms}
          />
        ))}
        {state.evidence.length === 0 && envelopes.some((e) => e.step_id === "query-grafana" && e.status === "done") ? (
          <p>No Grafana evidence returned.</p>
        ) : null}
      </div>
      {state.awaitingApproval ? (
        <ActionApproval actions={state.actions} disabled={approved || approving} approving={approving} onApprove={onApprove} />
      ) : null}
    </section>
  );
}
