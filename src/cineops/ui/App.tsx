// CineOps Guardian — App state machine + envelope reducer (DP-UI §5).
// The ONLY file that imports useEventStream. Screens receive RunState via props.
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { useEventStream } from "src/platform/transport/useEventStream.js";
import type { StreamStatus } from "src/platform/transport/useEventStream.js";
import type { EventEnvelope } from "src/platform/transport/event-envelope.js";
import { isDegradedEnvelope } from "src/platform/ui/index.js";
import type {
  CineOpsRunRequest,
  CineOpsQueryPlan,
  CineOpsGrafanaEvidence,
  CineOpsIncidentFinding,
  CineOpsRemediationAction,
  CineOpsWriteReceipt,
} from "../types.js";
import { STEP_IDS } from "../types.js";
import { postRun, postSeed, postUpload, postApprove } from "../api.js";
import { IngestScreen } from "./IngestScreen.js";
import { RunScreen } from "./RunScreen.js";
import { ResultScreen } from "./ResultScreen.js";
import { HealthPill } from "./components/HealthPill.js";

void STEP_IDS;

export type ScreenState = "ingest" | "run" | "result";

export interface RunState {
  status: "idle" | "running" | "awaiting-approval" | "done" | "error";
  plan: CineOpsQueryPlan | null;
  evidence: CineOpsGrafanaEvidence[];
  findings: CineOpsIncidentFinding[];
  actions: CineOpsRemediationAction[];
  receipts: CineOpsWriteReceipt[];
  totals: { hours_saved: number; mcp_calls: number; rows: number };
  summary: string;
  degraded: boolean;
  degradedReason: string;
  awaitingApproval: boolean;
  traceId: string | null;
  error: string | null;
  streamDeltas: Record<string, string>;
}

export const INITIAL_RUN_STATE: RunState = {
  status: "idle",
  plan: null,
  evidence: [],
  findings: [],
  actions: [],
  receipts: [],
  totals: { hours_saved: 0, mcp_calls: 0, rows: 0 },
  summary: "",
  degraded: false,
  degradedReason: "",
  awaitingApproval: false,
  traceId: null,
  error: null,
  streamDeltas: {},
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function reduceEnvelope(state: RunState, env: EventEnvelope): RunState {
  const payload = (env.payload ?? {}) as Record<string, unknown>;
  let next: RunState = state;
  const appendDelta = (key: string, delta: string): RunState => ({
    ...next,
    streamDeltas: { ...next.streamDeltas, [key]: (next.streamDeltas[key] ?? "") + delta },
  });
  switch (env.step_id) {
    case "load-context":
      if (env.status === "started") next = { ...next, status: "running" };
      else if (env.status === "streaming") next = appendDelta("load-context", str(payload["delta"]));
      else if (env.status === "done") {
        const shots = num(payload["shots"]);
        next = shots === null ? next : { ...next, totals: { ...next.totals, rows: shots } };
      }
      break;
    case "plan-queries":
      if (env.status === "started") next = appendDelta("plan-queries", str(payload["question"]));
      else if (env.status === "streaming") next = appendDelta("plan-queries", str(payload["delta"]));
      else if (env.status === "done" && payload["plan"] && typeof payload["plan"] === "object")
        next = { ...next, plan: payload["plan"] as CineOpsQueryPlan };
      break;
    case "query-grafana":
      if (env.status === "streaming") {
        // DP-UI §5.2: streaming cards are {mcp_tool, kind, rows, took_ms}
        // with a numeric row count (full evidence replaces them on done).
        const rows = num(payload["rows"]) ?? 0;
        const card = {
          mcp_tool: str(payload["mcp_tool"]),
          kind: str(payload["kind"]),
          rows,
          took_ms: num(payload["took_ms"]) ?? 0,
        } as unknown as CineOpsGrafanaEvidence;
        next = {
          ...next,
          evidence: [...next.evidence, card],
          totals: { ...next.totals, mcp_calls: next.totals.mcp_calls + 1, rows: next.totals.rows + rows },
        };
      } else if (env.status === "done") {
        if (Array.isArray(payload["evidence"])) next = { ...next, evidence: payload["evidence"] as CineOpsGrafanaEvidence[] };
        const mc = num(payload["mcp_calls"]);
        if (mc !== null) next = { ...next, totals: { ...next.totals, mcp_calls: mc } };
      }
      break;
    case "persist-snapshot":
      if (env.status === "done") {
        const rows = num(payload["rows"]) ?? 0;
        next = {
          ...next,
          totals: { ...next.totals, rows: next.totals.rows + rows },
          streamDeltas: { ...next.streamDeltas, "persist-snapshot": str(payload["table"]) },
        };
      }
      break;
    case "correlate-evidence":
      if (env.status === "streaming") next = appendDelta("correlate-evidence", str(payload["delta"]));
      else if (env.status === "done" && Array.isArray(payload["findings"]))
        next = { ...next, findings: payload["findings"] as CineOpsIncidentFinding[] };
      break;
    case "propose-remediation":
      if (env.status === "streaming") next = appendDelta("propose-remediation", str(payload["delta"]));
      else if (env.status === "done") {
        if (Array.isArray(payload["actions"])) next = { ...next, actions: payload["actions"] as CineOpsRemediationAction[] };
        const hs = num(payload["hours_saved"]);
        if (hs !== null) next = { ...next, totals: { ...next.totals, hours_saved: hs } };
      }
      break;
    case "write-back":
      if (env.status === "started" && payload["awaiting_approval"] === true) {
        next = {
          ...next,
          awaitingApproval: true,
          status: "awaiting-approval",
          actions: Array.isArray(payload["actions"]) ? (payload["actions"] as CineOpsRemediationAction[]) : next.actions,
        };
      } else if (env.status === "streaming") {
        next = appendDelta("write-back", str(payload["mcp_tool"]) + "/" + str(payload["action_id"]));
      } else if (env.status === "done") {
        next = {
          ...next,
          receipts: Array.isArray(payload["receipts"]) ? (payload["receipts"] as CineOpsWriteReceipt[]) : next.receipts,
          awaitingApproval: false,
          status: "running",
        };
      }
      break;
    case "summarize-run":
      if (env.status === "streaming") {
        const delta = str(payload["delta"]);
        next = { ...appendDelta("summarize-run", delta), summary: next.summary + delta };
      } else if (env.status === "done") {
        const totals = payload["totals"] as Record<string, unknown> | undefined;
        next = {
          ...next,
          summary: typeof payload["summary_markdown"] === "string" ? (payload["summary_markdown"] as string) : next.summary,
          totals: totals
            ? {
                hours_saved: num(totals["hours_saved"]) ?? next.totals.hours_saved,
                mcp_calls: num(totals["mcp_calls"]) ?? next.totals.mcp_calls,
                rows: num(totals["rows"]) ?? next.totals.rows,
              }
            : next.totals,
          status: "done",
        };
      }
      break;
    default:
      if (env.status !== "error") {
        console.warn("[ui] unknown step " + env.step_id);
        return state;
      }
      break;
  }
  if (env.status === "error") {
    const p = payload as Record<string, unknown>;
    next = { ...next, status: "error", error: str(p["error"] ?? p["message"] ?? "run failed") };
  }
  if (isDegradedEnvelope(env)) {
    next = { ...next, degraded: true, degradedReason: str((payload as Record<string, unknown>)["reason"] ?? "degraded fallback") };
  }
  return next;
}

export function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenState>("ingest");
  const [run, setRun] = useState<RunState>(INITIAL_RUN_STATE);
  const [seeding, setSeeding] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const { envelopes, status: streamStatus, reconnect } = useEventStream({ traceId: run.traceId ?? undefined });
  const appliedRef = useRef(0);
  const traceRef = useRef<string | null>(null);

  useEffect(() => {
    if (traceRef.current !== run.traceId) {
      traceRef.current = run.traceId;
      appliedRef.current = 0;
    }
    if (envelopes.length > appliedRef.current) {
      setRun((prev) => {
        let next = prev;
        for (let i = appliedRef.current; i < envelopes.length; i++) next = reduceEnvelope(next, envelopes[i] as EventEnvelope);
        appliedRef.current = envelopes.length;
        return next;
      });
    }
  }, [envelopes, run.traceId]);

  useEffect(() => {
    if (run.status === "done") setScreen("result");
  }, [run.status]);

  const onSeed = async (): Promise<void> => {
    setSeeding(true);
    try {
      await postSeed({ production: "NEON HOLLOW" });
    } finally {
      setSeeding(false);
    }
  };

  const onStart = async (req: CineOpsRunRequest, files?: File[]): Promise<void> => {
    try {
      if (req.corpus === "demo") await postSeed({ production: req.production });
      const { trace_id } = await postRun(req);
      if (files && files.length > 0) await postUpload(trace_id, files);
      appliedRef.current = 0;
      setApproved(false);
      setApproving(false);
      setRun({ ...INITIAL_RUN_STATE, traceId: trace_id, status: "running" });
      setScreen("run");
    } catch (e) {
      setRun({ ...INITIAL_RUN_STATE, status: "error", error: e instanceof Error ? e.message : String(e) });
      setScreen("run");
    }
  };

  const onApprove = async (ids: string[]): Promise<void> => {
    if (!run.traceId || approved) return;
    setApproving(true);
    try {
      await postApprove({ trace_id: run.traceId, action_ids: ids });
      setApproved(true);
      setRun((prev) => ({ ...prev, awaitingApproval: false, status: "running" }));
    } finally {
      setApproving(false);
    }
  };

  const onReset = (): void => {
    setRun(INITIAL_RUN_STATE);
    setScreen("ingest");
  };

  return (
    <div className="cineops-app" data-screen={screen}>
      <header className="cineops-header">
        <h1>CineOps Guardian</h1>
        <HealthPill ok={null} label="backend" />
      </header>
      {screen === "ingest" ? <IngestScreen onStart={onStart} seeding={seeding} onSeed={onSeed} /> : null}
      {screen === "run" ? (
        <RunScreen
          state={run}
          streamStatus={streamStatus as StreamStatus}
          onApprove={onApprove}
          approving={approving}
          approved={approved}
          envelopes={envelopes}
          onReconnect={reconnect}
          onReset={onReset}
        />
      ) : null}
      {screen === "result" ? <ResultScreen state={run} traceId={run.traceId} onReset={onReset} /> : null}
    </div>
  );
}
