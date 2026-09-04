// CineOps Guardian — TypeScript mirror of engine/schema/domain.py (DP-SCHEMA §3.4).
// Consumer: DP-UI only. Field names MUST match Python exactly (checked by WU-SCHEMA-04).
export const STEP_IDS: readonly string[] = [
  "load-context",
  "plan-queries",
  "query-grafana",
  "persist-snapshot",
  "correlate-evidence",
  "propose-remediation",
  "write-back",
  "summarize-run",
] as const;
export type StepId = (typeof STEP_IDS)[number];
export type ShotStatus = "queued" | "rendering" | "failed" | "review" | "approved" | "delivered";
export type EvidenceKind = "metrics" | "logs" | "traces" | "dashboards" | "alerts" | "incidents";
export type FindingLevel = "ok" | "low" | "medium" | "high" | "blocked";
export type ActionKind = "reprioritize" | "annotate" | "incident_note";
export type WritePath = "mcp" | "rest-fallback";
export type SeverityFloor = "low" | "medium" | "high";
export type Corpus = "demo" | "upload";
export interface CineOpsProductionShot { shot_id: string; production: string; episode_or_reel: string; scene: string; vfx_vendor: string | null; status: ShotStatus; priority: number; due_at: string; render_job_id: string | null; dependency_shot_ids: string[]; synthetic: boolean; }
export interface CineOpsDeliveryCommitment { commitment_id: string; source_file: string; production: string; deliverable: string; covers_shot_ids: string[]; due_at: string; owner: string; notes: string; confidence: number; page_refs: number[]; synthetic: boolean; }
export interface CineOpsQueryPlanStep { step_no: number; kind: EvidenceKind; tool_hint: string; args: Record<string, unknown>; why: string; }
export interface CineOpsQueryPlan { plan_id: string; question: string; window_from: string; window_to: string; steps: CineOpsQueryPlanStep[]; }
export interface CineOpsGrafanaEvidence { evidence_id: string; kind: EvidenceKind; mcp_tool: string; args: Record<string, unknown>; rows: Record<string, unknown>[]; row_count: number; grafana_link: string | null; took_ms: number; degraded: boolean; synthetic: boolean; }
export interface CineOpsIncidentFinding { finding_id: string; shot_id: string | null; level: FindingLevel; rule_ids: string[]; reasons: string[]; evidence_ids: string[]; commitment_ids: string[]; at_risk_hours: number; }
export interface CineOpsRemediationAction { action_id: string; finding_id: string; kind: ActionKind; target: string; new_priority: number | null; annotation_text: string | null; dashboard_uid: string | null; panel_id: number | null; time_ms: number | null; rationale: string; hours_saved: number; requires_approval: boolean; }
export interface CineOpsWriteReceipt { action_id: string; ok: boolean; mcp_tool: string; path: WritePath; remote_id: string | null; grafana_link: string | null; error: string | null; }
export interface CineOpsRunRequest { question: string; production: string; window_from: string; window_to: string; severity_floor: SeverityFloor; corpus: Corpus; uploads: string[]; trace_id: string | null; }
export interface CineOpsRunTotals { shots: number; blocked: number; high: number; at_risk_hours: number; hours_saved: number; mcp_calls: number; }
export interface CineOpsRunResult { trace_id: string; plan: CineOpsQueryPlan; evidence: CineOpsGrafanaEvidence[]; findings: CineOpsIncidentFinding[]; actions: CineOpsRemediationAction[]; receipts: CineOpsWriteReceipt[]; revised_shots: CineOpsProductionShot[]; totals: CineOpsRunTotals; summary_markdown: string; degraded: boolean; degraded_reasons: string[]; }
