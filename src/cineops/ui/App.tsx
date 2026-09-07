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
import { postRun, postSeed, postUpload, postApprove, getRecentEnvelopes } from "../api.js";
import { IngestScreen } from "./IngestScreen.js";
import { RunScreen } from "./RunScreen.js";
import { ResultScreen } from "./ResultScreen.js";
import { HealthPill } from "./components/HealthPill.js";
import { ThemeToggle } from "./ThemeToggle.js";
import { BrandMark } from "./BrandMark.js";
import { IndustryGuide } from "./components/IndustryGuide.js";
import type { DegradedStep } from "./components/DegradedBanner.js";

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
  degradedSteps: DegradedStep[];
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
  degradedSteps: [],
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
    // Explicit WHAT-degraded: backend degraded payloads carry `error` (and
    // query-grafana carries a `reasons` array); surface them per step instead
    // of the old generic single string.
    const p = payload as Record<string, unknown>;
    const rawReasons = p["reasons"];
    const reasonList = Array.isArray(rawReasons) ? rawReasons.map((r) => String(r)).filter((s) => s.length > 0) : [];
    const cause = (reasonList.slice(0, 3).join("; ") || str(p["reason"] ?? p["error"] ?? "fallback evidence used")).slice(0, 220);
    const seen = new Set(next.degradedSteps.map((d) => d.step));
    const steps = seen.has(env.step_id)
      ? next.degradedSteps
      : [...next.degradedSteps, { step: env.step_id, cause }];
    next = {
      ...next,
      degraded: true,
      degradedReason: next.degradedReason || cause,
      degradedSteps: steps,
    };
  }
  return next;
}

export function App(): JSX.Element {
  const [screen, setScreen] = useState<ScreenState>("ingest");
  const [run, setRun] = useState<RunState>(INITIAL_RUN_STATE);
  const [seeding, setSeeding] = useState(false);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [seedResult, setSeedResult] = useState<{ shots: number; metrics: number } | null>(null);
  const [approving, setApproving] = useState(false);
  const [approved, setApproved] = useState(false);
  const { envelopes, status: streamStatus, reconnect } = useEventStream({ traceId: run.traceId ?? undefined });
  // E2E F13: the chassis SSE hub is broadcast-only and closes idle streams
  // after ~15 s; our runs have multi-minute gaps. `merged` is the union of
  // live hook envelopes + replayed ones from GET /api/events/recent,
  // deduped by sequence and kept sorted. The reducer consumes ONLY merged,
  // so reconnects (which wipe the hook buffer) can never lose or duplicate
  // an envelope. `maxSeqRef` is the highest sequence applied so far.
  const [merged, setMerged] = useState<EventEnvelope[]>([]);
  const appliedSeqRef = useRef<Set<number>>(new Set());
  const maxSeqRef = useRef(-1);
  const traceRef = useRef<string | null>(null);
  const [pollAliveAt, setPollAliveAt] = useState(0);

  const ingest = (incoming: EventEnvelope[]): void => {
    const fresh = incoming.filter((e) => typeof e.sequence === "number" && !appliedSeqRef.current.has(e.sequence));
    if (fresh.length === 0) return;
    for (const e of fresh) {
      appliedSeqRef.current.add(e.sequence as number);
      if ((e.sequence as number) > maxSeqRef.current) maxSeqRef.current = e.sequence as number;
    }
    setMerged((prev) => {
      const seen = new Set(prev.map((e) => e.sequence));
      const next = [...prev, ...fresh.filter((e) => !seen.has(e.sequence))];
      next.sort((a, b) => (a.sequence as number) - (b.sequence as number));
      return next;
    });
  };

  useEffect(() => {
    if (traceRef.current !== run.traceId) {
      traceRef.current = run.traceId;
      appliedSeqRef.current = new Set();
      maxSeqRef.current = -1;
      setMerged([]);
      setPollAliveAt(0);
    }
  }, [run.traceId]);

  useEffect(() => {
    ingest(envelopes as EventEnvelope[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envelopes]);

  // Gap-filling poller: while a run is active, replay anything SSE missed.
  useEffect(() => {
    if (!run.traceId || run.status === "done" || run.status === "error" || run.status === "idle") return;
    let cancelled = false;
    const tick = async (): Promise<void> => {
      try {
        const res = await getRecentEnvelopes(run.traceId as string, maxSeqRef.current);
        if (cancelled) return;
        const envs = (res.envelopes ?? []) as EventEnvelope[];
        if (envs.length > 0) {
          ingest(envs);
          setPollAliveAt(Date.now());
        }
      } catch {
        // Poll failures are silent: SSE remains the primary channel.
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.traceId, run.status]);

  useEffect(() => {
    // Recompute from scratch on every merge: envelopes are append-only and
    // the reducer is deterministic, so a full recompute is identical to
    // incremental application — and immune to reconnect-induced skew.
    if (merged.length === 0) return;
    setRun((prev) => {
      if (!prev.traceId) return prev;
      let next: RunState = { ...INITIAL_RUN_STATE, traceId: prev.traceId, status: "running" };
      for (const env of merged) next = reduceEnvelope(next, env);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merged]);

  useEffect(() => {
    if (run.status === "done") setScreen("result");
  }, [run.status]);

  const onSeed = async (): Promise<void> => {
    setSeeding(true);
    setSeedError(null);
    setSeedResult(null);
    try {
      // The Seed button promises a (re)load: force the refresh path.
      const res = await postSeed({ production: "PALS", refresh: true });
      setSeedResult({ shots: res.shots, metrics: res.metrics });
    } catch (e) {
      // Seeding provisions BigQuery — meaningless offline. Report it, never
      // hide it, and never block Maya: the local corpus still runs degraded.
      setSeedError(e instanceof Error ? e.message : String(e));
    } finally {
      setSeeding(false);
    }
  };

  const onStart = async (req: CineOpsRunRequest, files?: File[]): Promise<void> => {
    try {
      if (req.corpus === "demo") {
        try {
          await postSeed({ production: req.production });
        } catch (e) {
          console.warn("[ui] seed degraded, continuing from local corpus: " + String(e));
          setSeedError(e instanceof Error ? e.message : String(e));
        }
      }
      const { trace_id } = await postRun(req);
      if (files && files.length > 0) await postUpload(trace_id, files);
      // Fresh trace: the traceRef effect resets merged/applied state.
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

  // Bug 2: pill must stay truthful when a green probe still failed mid-run.
  // Map degraded steps to the service the pill reports on.
  const STEP_SERVICE: Record<string, string> = {
    "plan-queries": "gemini",
    "summarize-run": "gemini",
    "query-grafana": "grafana-mcp",
    "persist-snapshot": "bigquery",
  };
  const runIssues = [...new Set(run.degradedSteps.map((d) => STEP_SERVICE[d.step]).filter((s): s is string => typeof s === "string"))];

  return (
    <div className="cineops-app" data-screen={screen}>
      <a className="cg-skip-link" href="#cg-main">
        Skip to content
      </a>
      <div className="cg-backdrop" aria-hidden="true">
        <div className="cg-backdrop-vignette" />
        <div className="cg-backdrop-grain" />
      </div>
      <header className="cineops-header">
        <div className="cg-brand">
          <BrandMark />
          <div>
            <h1>CineOps Guardian</h1>
            <span className="cg-brand-sub">Dailies Console</span>
          </div>
        </div>
        <div className="cg-header-right">
          <IndustryGuide />
          <HealthPill ok={null} label="backend" runIssues={runIssues} />
          <ThemeToggle />
        </div>
      </header>
      <main id="cg-main">
      {screen === "ingest" ? (
        <>
          {seedError ? <p role="alert">Seed degraded ({seedError}) — continuing from local corpus.</p> : null}
          <IngestScreen onStart={onStart} seeding={seeding} onSeed={onSeed} seedResult={seedResult} seedError={seedError} />
        </>
      ) : null}
      {screen === "run" ? (
        <RunScreen
          state={run}
          streamStatus={streamStatus as StreamStatus}
          onApprove={onApprove}
          approving={approving}
          approved={approved}
          envelopes={merged}
          onReconnect={reconnect}
          onReset={onReset}
          pollAlive={Date.now() - pollAliveAt < 10000}
        />
      ) : null}
      {screen === "result" ? <ResultScreen state={run} traceId={run.traceId} onReset={onReset} /> : null}
      </main>
      <footer className="cg-footer">Synthetic demo data · writes require approval · Grafana links open the source panel</footer>
    </div>
  );
}
