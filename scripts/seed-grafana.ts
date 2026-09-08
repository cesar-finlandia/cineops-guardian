// DP-CORPUS — Grafana seeder (WU-CORPUS-06, live, cross-service).
// Pushes render_queue_metrics.csv via Prometheus remote-write (hand-encoded
// WriteRequest + raw snappy block compression, literals only), failed_jobs.jsonl
// via Loki push, then provisions dashboard.json + alert-rules.yaml. Idempotent:
// re-runs overwrite the same dashboard uid / ruler group in place.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CORPUS = join(ROOT, "engine", "rag", "corpus");

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

// --- minimal protobuf writer (varint / fixed64 / length-delimited) ---
function varint(v: number | bigint): number[] {
  let n = typeof v === "bigint" ? v : BigInt(v);
  const out: number[] = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return out;
}
function tag(field: number, wire: number): number[] {
  return varint((field << 3) | wire);
}
function ldelim(field: number, bytes: number[]): number[] {
  return [...tag(field, 2), ...varint(bytes.length), ...bytes];
}
function str(s: string): number[] {
  return Array.from(Buffer.from(s, "utf8"));
}
function label(name: string, value: string): number[] {
  return [...ldelim(1, str(name)), ...ldelim(2, str(value))];
}
function sample(value: number, timestampMs: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeDoubleLE(value, 0);
  return [...tag(1, 1), ...Array.from(buf), ...tag(2, 0), ...varint(timestampMs)];
}
function timeSeries(labels: number[][], samples: number[][]): number[] {
  const out: number[] = [];
  for (const l of labels) out.push(...ldelim(1, l));
  for (const s of samples) out.push(...ldelim(2, s));
  return out;
}
function writeRequest(series: number[][]): Buffer {
  const out: number[] = [];
  for (const ts of series) out.push(...ldelim(1, ts));
  return Buffer.from(out);
}

// --- raw snappy block encoder (literals only, no runtime dep) ---
// CRITICAL: Prometheus remote-write bodies are RAW snappy blocks, NOT framed
// streams. A previous version emitted xerial-style framing (stream identifier
// + checksummed chunks) and Cloud answered "decompress snappy: corrupt input"
// for every batch. Raw block layout: varint(uncompressed length) followed by
// literal elements (tag + bytes). No identifier, no chunks, no checksums.
function snappyBlock(raw: Buffer): Buffer {
  // Buffer.concat throughout: argument spreading 10k+ bytes overflows the
  // call stack (found by the self-test at 200 kB).
  const n = raw.length;
  let tag: Buffer;
  if (n <= 60) {
    tag = Buffer.from([((n - 1) << 2) | 0]);
  } else {
    const lenBytes: number[] = [];
    let tmp = n - 1;
    while (tmp > 0) {
      lenBytes.push(tmp & 0xff);
      tmp >>= 8;
    }
    tag = Buffer.from([(59 + lenBytes.length) << 2, ...lenBytes]);
  }
  return Buffer.concat([Buffer.from(varint(n)), tag, raw]);
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const header = (lines[0] ?? "").split(",");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
}

async function req(url: string, init: RequestInit, auth: string, label_: string): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: auth },
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      attempt++;
      await new Promise((r) => setTimeout(r, [1000, 2000, 4000][attempt - 1]));
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`seed:grafana: ${label_} failed with ${res.status}: ${body.slice(0, 300)}`);
    }
    return res;
  }
}

async function main(): Promise<void> {
  const stack = env("GRAFANA_STACK_URL");
  const token = env("GRAFANA_SERVICE_ACCOUNT_TOKEN");
  if (!stack || !token) {
    console.log("seed:grafana: missing GRAFANA_STACK_URL or GRAFANA_SERVICE_ACCOUNT_TOKEN — set them in .env (see config/env.example)");
    process.exit(1);
  }
  const base = stack.replace(/\/$/, "");
  const bearer = `Bearer ${token}`;
  // Grafana Cloud does NOT serve Prometheus/Loki ingestion at the stack root
  // (${base}/api/prom/... and ${base}/loki/... 404 there). Push goes to the
  // per-instance hosts from the Cloud portal (Connections → Details):
  //   GRAFANA_PROM_PUSH_URL=https://prometheus-prod-XX.grafana.net/api/prom/push
  //   GRAFANA_LOKI_PUSH_URL=https://logs-prod-XX.grafana.net/loki/api/v1/push
  // with Basic auth (username = instance ID on the same details page,
  // password = a token with metrics:write / logs:write scope). When unset,
  // the legacy stack-root paths are used (self-hosted layouts).
  function pushTarget(prefix: string, legacyPath: string): { url: string; auth: string } {
    const override = env(`GRAFANA_${prefix}_PUSH_URL`);
    if (!override) return { url: `${base}${legacyPath}`, auth: bearer };
    const user = env(`GRAFANA_${prefix}_USER`);
    const pass = env(`GRAFANA_${prefix}_PASS`);
    if (!user || !pass) {
      console.log(`seed:grafana: ${prefix} push URL set but GRAFANA_${prefix}_USER/PASS missing`);
      process.exit(1);
    }
    return { url: override, auth: "Basic " + Buffer.from(`${user}:${pass}`, "utf8").toString("base64") };
  }
  const prom = pushTarget("PROM", "/api/prom/api/v1/write");
  const loki = pushTarget("LOKI", "/loki/api/v1/push");
  const manifest = JSON.parse(readFileSync(join(CORPUS, "CORPUS.json"), "utf8")) as {
    incident_window: { from: string; to: string; vendor: string };
  };
  const metricsAll = parseCsv(readFileSync(join(CORPUS, "telemetry", "render_queue_metrics.csv"), "utf8"));
  const logsAll = readFileSync(join(CORPUS, "telemetry", "failed_jobs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  // Cloud push window: Grafana Cloud's out-of-order gate rejects anything more
  // than ~tens of minutes old, so neither the 7-day grid nor a shifted copy
  // of it can ever land there. The demo only queries the 90-minute incident
  // window (long-range trend context lives in BigQuery, not Grafana), so for
  // a Cloud-targeted push (SEED_SHIFT_TO_NOW=1) the incident is linearly
  // re-mapped onto [now-25min, now-5min]: values and cross-source alignment
  // preserved, absolute clock fresh. Local/docker pushes keep real timestamps
  // (long retention there).
  const winFrom = Date.parse(manifest.incident_window.from);
  const winTo = Date.parse(manifest.incident_window.to);
  const shiftToNow = ["1", "true", "yes"].includes((process.env["SEED_SHIFT_TO_NOW"] ?? "").toLowerCase());
  const EFF_END = Date.now() - 5 * 60 * 1000;
  const EFF_START = EFF_END - 20 * 60 * 1000;
  const mapTs = (iso: string): number => {
    const t = Date.parse(iso);
    const f = Math.min(1, Math.max(0, (t - winFrom) / (winTo - winFrom)));
    return Math.round(EFF_START + f * (EFF_END - EFF_START));
  };
  let metrics = metricsAll;
  let logs = logsAll;
  // tsOf resolves a corpus timestamp to the epoch ms actually pushed.
  let tsOf = (iso: string): number => Date.parse(iso);
  if (shiftToNow) {
    metrics = metricsAll.filter((m) => {
      const t = Date.parse(m["ts"] as string);
      return t >= winFrom && t <= winTo;
    });
    logs = logsAll.filter((l) => {
      try {
        const t = Date.parse((JSON.parse(l) as { ts: string }).ts);
        return t >= winFrom && t <= winTo;
      } catch {
        return false;
      }
    });
    tsOf = (iso: string): number => mapTs(iso);
    console.log(`seed:grafana: Cloud re-map kept ${metrics.length}/${metricsAll.length} metric rows, ${logs.length}/${logsAll.length} log lines`);
    const fmtEarly = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    console.log(`seed:grafana: EFFECTIVE window (use in Diagnose form): ${fmtEarly(EFF_START)} → ${fmtEarly(EFF_END)}`);
  }

  // Timestamp rule (DP-CORPUS §6 FM-01): generation literals stay frozen on
  // disk. Local pushes use real timestamps (long retention). Cloud pushes
  // (shiftToNow, mapped above) already resolve through tsOf; only the legacy
  // 30-day retention shift still needs shiftMs here.
  const maxTs = Math.max(...metrics.map((m) => Date.parse(m["ts"] as string)));
  let shiftMs = 0;
  if (!shiftToNow && Date.now() - maxTs > 30 * 24 * 3600 * 1000) {
    shiftMs = Date.now() - 2 * 3600 * 1000 - maxTs;
    tsOf = (iso: string): number => Date.parse(iso) + shiftMs;
    console.log(`seed:grafana: shifted timestamps by ${Math.round(shiftMs / 1000)}s to fit retention`);
  }

  // 1) Metrics push: 500 samples per request, split further when one raw
  // block would exceed 60_000 uncompressed bytes (keeps every POST a
  // single small raw snappy block, valid for any receiver block limit).
  async function pushSeries(series: number[][], label_: string): Promise<void> {
    const raw = writeRequest(series);
    if (raw.length > 60000 && series.length > 1) {
      const half = Math.ceil(series.length / 2);
      await pushSeries(series.slice(0, half), label_);
      await pushSeries(series.slice(half), label_);
      return;
    }
    const body = snappyBlock(raw);
    await req(
      prom.url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-protobuf",
          "Content-Encoding": "snappy",
          "X-Prometheus-Remote-Write-Version": "0.1.0",
        },
        body: body as unknown as BodyInit,
      },
      prom.auth,
      label_,
    );
    await new Promise((r) => setTimeout(r, 250));
  }
  const BATCH = 500;
  for (let i = 0; i < metrics.length; i += BATCH) {
    const batch = metrics.slice(i, i + BATCH);
    const series = batch.map((m) =>
      timeSeries(
        [
          label("__name__", "cineops_render_queue_latency_seconds"),
          label("production", m["production"] as string),
          label("vendor", m["vendor"] as string),
          label("job_id", m["job_id"] as string),
          label("shot_id", m["shot_id"] as string),
          label("status", m["status"] as string),
        ],
        [sample(Number(m["queue_latency_sec"]), tsOf(m["ts"] as string))],
      ),
    );
    await pushSeries(series, `metrics batch ${i / BATCH}`);
  }

  // 2) Logs push: 200 lines per request, grouped by vendor stream labels.
  // The embedded "ts" inside each line's JSON is rewritten to the pushed
  // timestamp as well, so evidence rows read consistently on camera.
  const fmtIso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const LOG_BATCH = 200;
  for (let i = 0; i < logs.length; i += LOG_BATCH) {
    const batch = logs.slice(i, i + LOG_BATCH);
    const byVendor = new Map<string, { ts: string; line: string }[]>();
    for (const line of batch) {
      const obj = JSON.parse(line) as { ts: string; job_id: string };
      const vendor = metrics.find((m) => m["job_id"] === obj.job_id)?.["vendor"] ?? "unknown";
      const pushedTs = fmtIso(tsOf(obj.ts));
      let lineOut = line;
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        o["ts"] = pushedTs;
        lineOut = JSON.stringify(o);
      } catch {
        lineOut = line;
      }
      const arr = byVendor.get(vendor) ?? [];
      arr.push({ ts: pushedTs, line: lineOut });
      byVendor.set(vendor, arr);
    }
    const streams = [...byVendor.entries()].map(([vendor, vals]) => ({
      stream: { production: "PALS", job: "render", vendor },
      values: vals.map((v) => [String(tsOf(v.ts) * 1e6), v.line]),
    }));
    await req(
      loki.url,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ streams }) },
      loki.auth,
      `logs batch ${i / LOG_BATCH}`,
    );
  }

  // 3) Dashboard provision: GET-then-POST, overwrite in place. The committed
  // dashboard.json is stack-portable (placeholder uids "prometheus"/"loki");
  // rebind them here to this stack's real datasource UIDs, or every panel
  // renders "datasource was not found". Panel-1's expr is also validated to
  // reference the pushed gauge metric (never histogram buckets we don't ship).
  const dashboard = JSON.parse(readFileSync(join(ROOT, "grafana", "dashboard.json"), "utf8"));
  try {
    const dsRes = await fetch(`${base}/api/datasources`, { headers: { Authorization: bearer } });
    if (dsRes.ok) {
      const dsList = (await dsRes.json()) as { type: string; uid: string; isDefault?: boolean; name?: string }[];
      const pick = (t: string): string | null => {
        const cands = dsList.filter((d) => (d.type || "").toLowerCase() === t);
        if (cands.length === 0) return null;
        return (cands.find((d) => d.isDefault) ?? cands[0] as { uid: string }).uid;
      };
      const promUid = pick("prometheus");
      const lokiUid = pick("loki");
      for (const p of dashboard.panels ?? []) {
        const want = p?.datasource?.type === "loki" ? lokiUid : p?.datasource?.type === "prometheus" ? promUid : null;
        if (want) {
          p.datasource = { type: p.datasource.type, uid: want };
          for (const t of p.targets ?? []) t.datasource = { type: p.datasource.type, uid: want };
        }
      }
      console.log(`seed:grafana: rebound datasources to prometheus=${promUid} loki=${lokiUid}`);
    } else {
      console.log(`seed:grafana: WARNING: datasource lookup ${dsRes.status}, pushing dashboard with placeholder uids`);
    }
  } catch (e) {
    console.log(`seed:grafana: WARNING: datasource rebind skipped (${String(e).slice(0, 120)})`);
  }
  const existing = await fetch(`${base}/api/dashboards/uid/cineops-render-queue`, {
    headers: { Authorization: bearer },
  });
  if (existing.status === 200) {
    const body = (await existing.json()) as { dashboard: { version: number } };
    dashboard.version = (body.dashboard?.version ?? 1) + 1;
    await req(
      `${base}/api/dashboards/db`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboard, overwrite: true }) },
      bearer,
      "dashboard overwrite",
    );
    console.log("seed:grafana: already provisioned / updated in place: cineops-render-queue");
  } else if (existing.status === 404) {
    await req(
      `${base}/api/dashboards/db`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dashboard, overwrite: false }) },
      bearer,
      "dashboard create",
    );
  } else {
    throw new Error(`seed:grafana: dashboard lookup failed with ${existing.status}`);
  }

  // 4) Alert rule provision: overwrite the same ruler group. A 403 here means
  // the token lacks alert.rules:write — warn and continue, since the demo
  // runs fully without the provisioned rule (R-QUEUE/R-FAILRUN carry it);
  // every other failure still throws.
  const rulesYaml = readFileSync(join(ROOT, "grafana", "alert-rules.yaml"), "utf8");
  try {
    await req(
      `${base}/api/ruler/grafana/api/v1/rules/CineOps`,
      { method: "POST", headers: { "Content-Type": "application/yaml" }, body: rulesYaml },
      bearer,
      "alert rules",
    );
  } catch (e) {
    if (String(e).includes("failed with 403")) {
      console.log("seed:grafana: WARNING: alert rules skipped (token needs alert.rules:write; grant it in the Cloud portal if you want R-ALERT evidence — demo works without it)");
    } else {
      throw e;
    }
  }

  console.log("seed:grafana: dashboard_uid=cineops-render-queue panel_id=1 provisioned");
  console.log(`seed:grafana: incident window ${manifest.incident_window.from} → ${manifest.incident_window.to}`);
  if (shiftToNow) {
    const fmt = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
    console.log(`seed:grafana: EFFECTIVE window after re-map (use in Diagnose form): ${fmt(tsOf(manifest.incident_window.from))} → ${fmt(tsOf(manifest.incident_window.to))}`);
  } else if (shiftMs !== 0) {
    const eff = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString().replace(/\.\d{3}Z$/, "Z");
    console.log(`seed:grafana: EFFECTIVE window after shift (use in Diagnose form): ${eff(manifest.incident_window.from)} → ${eff(manifest.incident_window.to)}`);
  }
}

await main();
