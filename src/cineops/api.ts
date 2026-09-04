/// <reference types="vite/client" />
// CineOps Guardian — typed backend route helpers (DP-UI §3.1).
// The only fetch() calls under src/cineops/.
import type {
  CineOpsRunRequest,
  CineOpsRunResult,
  CineOpsRemediationAction,
} from "./types.js";

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

async function check(res: Response): Promise<Response> {
  if (!res.ok) throw new Error("api " + res.status);
  return res;
}

export async function postRun(body: CineOpsRunRequest): Promise<{ trace_id: string }> {
  const res = await fetch(BASE + "/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await check(res);
  return (await res.json()) as { trace_id: string };
}

export async function postApprove(body: { trace_id: string; action_ids: string[] }): Promise<{ released: number }> {
  const res = await fetch(BASE + "/api/approve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await check(res);
  return (await res.json()) as { released: number };
}

export async function getResult(
  trace_id: string,
): Promise<CineOpsRunResult | { status: "running" } | { status: "awaiting-approval"; actions: CineOpsRemediationAction[] }> {
  const res = await fetch(BASE + "/api/result/" + encodeURIComponent(trace_id));
  await check(res);
  return (await res.json()) as CineOpsRunResult | { status: "running" };
}

export async function postSeed(body: { production: string }): Promise<{ shots: number; metrics: number }> {
  const res = await fetch(BASE + "/api/seed", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await check(res);
  return (await res.json()) as { shots: number; metrics: number };
}

export async function postUpload(trace_id: string, files: File[]): Promise<{ paths: string[] }> {
  const form = new FormData();
  form.append("trace_id", trace_id);
  for (const f of files) form.append("files", f);
  const res = await fetch(BASE + "/api/upload", { method: "POST", body: form });
  await check(res);
  return (await res.json()) as { paths: string[] };
}

export async function getHealth(): Promise<{
  ok: boolean;
  gemini: unknown;
  grafana_mcp: unknown;
  bigquery: unknown;
  cost: unknown;
  degraded: boolean;
}> {
  const res = await fetch(BASE + "/api/health");
  await check(res);
  return (await res.json()) as {
    ok: boolean;
    gemini: unknown;
    grafana_mcp: unknown;
    bigquery: unknown;
    cost: unknown;
    degraded: boolean;
  };
}
