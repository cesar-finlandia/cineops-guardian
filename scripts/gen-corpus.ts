// DP-CORPUS — synthetic corpus generator (WU-CORPUS-01..05).
// NOTE (DP-CORPUS §6 FM-04): pdfkit is not installed in this environment, so
// memo PDFs are rendered via the vendored born-digital writer in
// scripts/minimal-pdf.ts (text-selectable PDF 1.4, exact first-line watermark).
// NOTE (DP-CORPUS §4): repo scripts live at scripts/*.ts (repo root), so the
// chassis import resolves via "../src/..." (the plan text shows "../../src/..."
// which would escape the repo root from here).
// NOTE: generated_at is frozen to incident `to` + 1h (2026-09-04T16:30:00Z) so
// re-runs are byte-identical (WU-CORPUS-01).
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRecords, generateDocuments, watermarkBatch, WATERMARK_HEADER_TEXT } from "../src/data/index.js";
import { setProviderCall } from "../src/data/provider.js";
import { mulberry32, hashString } from "./seeded-rng.js";
import { writeMinimalPdf } from "./minimal-pdf.js";

void generateRecords;
void generateDocuments;
void hashString;

const SEED = 20260904;
const PRODUCTION = "NEON HOLLOW";
const INCIDENT_FROM = "2026-09-04T14:00:00Z";
const INCIDENT_TO = "2026-09-04T15:30:00Z";
const INCIDENT_VENDOR = "HELIOSFORGE";
const GENERATED_AT = "2026-09-04T16:30:00Z";
const DASHBOARD_UID = "cineops-render-queue";
const PANEL_ID = 1;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "engine", "rag", "corpus");
const SHOTS_DIR = join(CORPUS, "shots");
const MEMOS_DIR = join(CORPUS, "memos");
const TELEMETRY_DIR = join(CORPUS, "telemetry");
const GRAFANA_DIR = join(ROOT, "grafana");

let providerSeed = SEED;

export function registerDeterministicProvider(seed: number = SEED): void {
  providerSeed = seed;
  setProviderCall(async (prompt: string, _model_profile: string): Promise<string> => {
    const rand = mulberry32(hashString(prompt + "|" + String(providerSeed)));
    return JSON.stringify({ echo_seed: providerSeed, r: rand(), prompt_len: prompt.length });
  });
}

const VENDORS = ["HELIOSFORGE", "PRISMWORKS", "VANTASTUDIO", "LUMENFRAME"];
const DELIVERABLES = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
const DUES = [
  "2026-09-06T17:00:00Z",
  "2026-09-07T17:00:00Z",
  "2026-09-08T17:00:00Z",
  "2026-09-09T17:00:00Z",
  "2026-09-10T17:00:00Z",
  "2026-09-11T17:00:00Z",
];
const OWNERS = ["M. Okafor", "J. Reyes", "A. Lindqvist", "R. Patel", "S. Chen", "D. Marsh"];
const PDF_NAMES = [
  "01-neon-hollow-deliverable-alpha.pdf",
  "02-neon-hollow-deliverable-beta.pdf",
  "03-neon-hollow-deliverable-gamma.pdf",
  "04-neon-hollow-deliverable-delta.pdf",
  "05-neon-hollow-deliverable-epsilon.pdf",
  "06-neon-hollow-deliverable-zeta.pdf",
];
const NOTES = [
  "Final VFX turnover for the opening city flyover; night plates graded and grain-matched.",
  "Creature cleanup and wire removal across the canyon chase; roto locked per supervisor review.",
  "Neon signage replacements and hologram inserts for the market sequence; font pack v3 approved.",
  "Storm extension and sky replacements for the rooftop duel; sim caches versioned and archived.",
  "Crowd tiling and digi-double integration for the plaza evacuation; matchmove re-exported.",
  "Title-sequence particle pass and end-card compositing; color pipeline ACEScg throughout.",
];

function pad3(n: number): string {
  return String(n).padStart(3, "0");
}

function toDueAt(baseMs: number): string {
  return new Date(baseMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}

interface ShotRow extends Record<string, unknown> {
  shot_id: string;
}

function buildShots(rand: () => number): ShotRow[] {
  const rows: ShotRow[] = [];
  // Status mix totals 240; the 15 failed rows go to the first 15 HELIOSFORGE shots.
  const restStatuses: string[] = [
    ...Array<string>(90).fill("delivered"),
    ...Array<string>(40).fill("approved"),
    ...Array<string>(30).fill("review"),
    ...Array<string>(40).fill("rendering"),
    ...Array<string>(25).fill("queued"),
  ];
  const failedHELIOS: number[] = [];
  for (let i = 0; failedHELIOS.length < 15; i++) {
    if (VENDORS[i % 4] === "HELIOSFORGE") failedHELIOS.push(i);
  }
  const failedSet = new Set(failedHELIOS);
  const baseMs = Date.parse("2026-09-02T00:00:00Z");
  const stepMs = (10 * 24 * 3600 * 1000) / 240; // 1h steps over 10 days
  const incidentToMs = Date.parse(INCIDENT_TO);
  let restIdx = 0;
  for (let i = 0; i < 240; i++) {
    const shotId = `NH-${pad3(i + 1)}`;
    const vendor = VENDORS[i % 4] as string;
    const failed = failedSet.has(i);
    const status = failed ? "failed" : (restStatuses[restIdx++] as string);
    let priority = 1 + Math.floor(rand() * 5);
    const dueMs = baseMs + i * stepMs;
    if (failed || (vendor === "HELIOSFORGE" && dueMs - incidentToMs >= 0 && dueMs - incidentToMs <= 72 * 3600 * 1000)) {
      priority = Math.max(priority, 4);
    }
    const deps: string[] = [];
    if (i > 0 && rand() < 0.35) deps.push(`NH-${pad3(i)}`);
    if (i > 1 && rand() < 0.2) deps.push(`NH-${pad3(1 + Math.floor(rand() * i))}`);
    rows.push({
      shot_id: shotId,
      production: PRODUCTION,
      episode_or_reel: ["R1", "R2", "R3"][i % 3] as string,
      scene: `SC-${pad3(1 + (i % 24))}`,
      vfx_vendor: vendor,
      status,
      priority,
      due_at: toDueAt(dueMs),
      render_job_id: `rq-nh-${pad3(i + 1)}`.toLowerCase(),
      dependency_shot_ids: deps.join(";"),
    });
  }
  watermarkBatch(rows, "records", WATERMARK_HEADER_TEXT);
  return rows;
}

function shotsCsv(rows: ShotRow[]): string {
  const header = "shot_id,production,episode_or_reel,scene,vfx_vendor,status,priority,due_at,render_job_id,dependency_shot_ids";
  const lines = [header];
  for (const r of rows) {
    lines.push(
      [r["shot_id"], r["production"], r["episode_or_reel"], r["scene"], r["vfx_vendor"], r["status"], String(r["priority"]), r["due_at"], r["render_job_id"], r["dependency_shot_ids"]].join(","),
    );
  }
  return lines.join("\n") + "\n";
}

interface MetricRow {
  ts: string;
  production: string;
  job_id: string;
  shot_id: string;
  queue_latency_sec: number;
  status: string;
  vendor: string;
}

function buildMetrics(rand: () => number): { metrics: MetricRow[]; logs: Record<string, unknown>[] } {
  const gridStart = Date.parse("2026-08-29T15:30:00Z");
  const stepMs = 5 * 60 * 1000;
  const steps = 2016;
  const fromMs = Date.parse(INCIDENT_FROM);
  const toMs = Date.parse(INCIDENT_TO);
  // Vendor shot pools: 60 shots each.
  const pools: Record<string, string[]> = { HELIOSFORGE: [], PRISMWORKS: [], VANTASTUDIO: [], LUMENFRAME: [] };
  for (let i = 0; i < 240; i++) {
    const v = VENDORS[i % 4] as string;
    (pools[v] as string[]).push(`NH-${pad3(i + 1)}`);
  }
  const metrics: MetricRow[] = [];
  const logs: Record<string, unknown>[] = [];
  for (let s = 0; s < steps; s++) {
    const tsMs = gridStart + s * stepMs;
    const ts = toDueAt(tsMs);
    const inWindow = tsMs >= fromMs && tsMs <= toMs;
    for (const vendor of VENDORS) {
      const pool = pools[vendor] as string[];
      const shotId = pool[s % pool.length] as string;
      const jobId = `rq-${shotId.toLowerCase()}`;
      let latency = Math.round((25 + rand() * 35) * 1000) / 1000;
      let status = rand() < 0.004 ? "failed" : "completed";
      if (inWindow && vendor === INCIDENT_VENDOR) {
        latency = Math.round((25 + rand() * 35) * 12 * 1000) / 1000;
        status = s % 3 === 0 ? "failed" : "completed";
      }
      metrics.push({ ts, production: PRODUCTION, job_id: jobId, shot_id: shotId, queue_latency_sec: latency, status, vendor });
      if (status === "failed") {
        const lineCount = inWindow && vendor === INCIDENT_VENDOR ? (rand() < 0.5 ? 2 : 1) : 1;
        for (let k = 0; k < lineCount; k++) {
          let hex = "";
          for (let h = 0; h < 12; h++) hex += Math.floor(rand() * 16).toString(16);
          logs.push({
            ts,
            job_id: jobId,
            shot_id: shotId,
            level: "ERROR",
            msg: `render failed: ${jobId} ${shotId} queue timeout after ${latency}s (${WATERMARK_HEADER_TEXT})`,
            trace_id: `tr-${hex}`,
          });
        }
      }
    }
  }
  metrics.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  logs.sort((a, b) => (String(a["ts"]) < String(b["ts"]) ? -1 : 1));
  return { metrics, logs };
}

function metricsCsv(rows: MetricRow[]): string {
  const lines = ["ts,production,job_id,shot_id,queue_latency_sec,status,vendor"];
  for (const r of rows) lines.push([r.ts, r.production, r.job_id, r.shot_id, String(r.queue_latency_sec), r.status, r.vendor].join(","));
  return lines.join("\n") + "\n";
}

interface Commitment {
  commitment_id: string;
  source_file: string;
  production: string;
  deliverable: string;
  covers_shot_ids: string[];
  due_at: string;
  owner: string;
  notes: string;
  confidence: number;
  page_refs: number[];
  synthetic: boolean;
}

function buildCommitments(): Commitment[] {
  const out: Commitment[] = [];
  for (let k = 0; k < 6; k++) {
    const ids: string[] = [];
    for (let n = k * 40 + 1; n <= k * 40 + 40; n++) ids.push(`NH-${pad3(n)}`);
    out.push({
      commitment_id: `C-NH-0${k + 1}`,
      source_file: PDF_NAMES[k] as string,
      production: PRODUCTION,
      deliverable: DELIVERABLES[k] as string,
      covers_shot_ids: ids,
      due_at: DUES[k] as string,
      owner: OWNERS[k] as string,
      notes: NOTES[k] as string,
      confidence: 1.0,
      page_refs: [1],
      synthetic: true,
    });
  }
  return out;
}

function renderMemos(commitments: Commitment[]): void {
  commitments.forEach((c, k) => {
    writeMinimalPdf(join(MEMOS_DIR, c.source_file), memoLines(k, c));
  });
  // Compatibility alias (DP-INGEST/DP-GEMINI verification filenames): the same
  // watermarked memo-1 bytes under the legacy name. Deterministic (same input).
  writeMinimalPdf(join(MEMOS_DIR, "01-vfx-delivery-memo.pdf"), memoLines(0, commitments[0] as Commitment));
}

function memoLines(k: number, c: Commitment): string[] {
  return [
    WATERMARK_HEADER_TEXT,
    "",
    `NEON HOLLOW — VFX Delivery Memo ${k + 1}/6`,
    `Deliverable: ${c.deliverable}`,
    `Due: ${c.due_at}`,
    `Owner: ${c.owner}`,
    `Shots: ${c.covers_shot_ids.join(", ")}`,
    "",
    c.notes,
  ];
}

function dashboardJson(): string {
  return (
    JSON.stringify(
      {
        uid: DASHBOARD_UID,
        title: "CineOps — NEON HOLLOW render queue",
        tags: ["cineops", "synthetic"],
        timezone: "utc",
        schemaVersion: 39,
        version: 1,
        panels: [
          {
            id: 1,
            title: "Render queue latency (p95, sec) — NEON HOLLOW",
            type: "timeseries",
            datasource: { type: "prometheus", uid: "prometheus" },
            targets: [
              {
                refId: "A",
                expr: 'histogram_quantile(0.95, sum by (le, vendor) (rate(cineops_render_queue_latency_seconds_bucket{production="NEON HOLLOW"}[$__rate_interval])))',
              },
            ],
          },
          {
            id: 2,
            title: "Failed jobs — NEON HOLLOW",
            type: "table",
            datasource: { type: "loki", uid: "loki" },
            targets: [{ refId: "A", expr: '{production="NEON HOLLOW"} |= "failed"' }],
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

function alertRulesYaml(): string {
  return `apiVersion: 1
groups:
  - orgId: 1
    name: cineops-render-queue
    folder: CineOps
    interval: 1m
    rules:
      - uid: cineops-p95-latency-high
        title: CineOps render queue p95 latency high — NEON HOLLOW
        condition: C
        data:
          - refId: A
            queryType: range
            relativeTimeRange: { from: 600, to: 0 }
            datasourceUid: prometheus
            model:
              expr: histogram_quantile(0.95, sum by (le, vendor) (rate(cineops_render_queue_latency_seconds_bucket{production="NEON HOLLOW"}[5m])))
          - refId: C
            datasourceUid: __expr__
            model:
              type: threshold
              expression: A
              conditions:
                - evaluator: { type: gt, params: [300] }
        annotations:
          summary: "SYNTHETIC DEMO DATA — NOT REAL: p95 render-queue latency above 300s"
        labels:
          production: NEON HOLLOW
          synthetic: "true"
          severity: critical
`;
}

async function main(): Promise<void> {
  registerDeterministicProvider(SEED);
  const rand = mulberry32(SEED);
  const shots = buildShots(rand);
  const { metrics, logs } = buildMetrics(rand);
  const commitments = buildCommitments();
  mkdirSync(SHOTS_DIR, { recursive: true });
  mkdirSync(MEMOS_DIR, { recursive: true });
  mkdirSync(TELEMETRY_DIR, { recursive: true });
  mkdirSync(GRAFANA_DIR, { recursive: true });
  writeFileSync(join(SHOTS_DIR, "shot_list.csv"), shotsCsv(shots), "utf8");
  writeFileSync(join(TELEMETRY_DIR, "render_queue_metrics.csv"), metricsCsv(metrics), "utf8");
  writeFileSync(join(TELEMETRY_DIR, "failed_jobs.jsonl"), logs.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  renderMemos(commitments);
  // Sidecar: six canonical entries + the deterministic alias entry for the
  // legacy filename (same commitment, alias source_file; fallback filters by
  // basename so degraded INGEST/GEMINI paths resolve under either name).
  const aliasEntry: Commitment = { ...(commitments[0] as Commitment), source_file: "01-vfx-delivery-memo.pdf" };
  const sidecar: Commitment[] = [...commitments, aliasEntry];
  writeFileSync(join(MEMOS_DIR, "commitments.json"), JSON.stringify(sidecar, null, 2) + "\n", "utf8");
  writeFileSync(join(GRAFANA_DIR, "dashboard.json"), dashboardJson(), "utf8");
  writeFileSync(join(GRAFANA_DIR, "alert-rules.yaml"), alertRulesYaml(), "utf8");
  const manifest = {
    production: PRODUCTION,
    generated_at: GENERATED_AT,
    synthetic: true,
    seed: SEED,
    counts: { shots: 240, memos: 6, metric_rows: metrics.length, log_rows: logs.length },
    dashboard_uid: DASHBOARD_UID,
    panel_id: PANEL_ID,
    incident_window: { from: INCIDENT_FROM, to: INCIDENT_TO, vendor: INCIDENT_VENDOR },
    generator: "src/data",
  };
  writeFileSync(join(CORPUS, "CORPUS.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`gen:corpus: shots=${shots.length} metrics=${metrics.length} logs=${logs.length} memos=${commitments.length}`);
}

await main();
