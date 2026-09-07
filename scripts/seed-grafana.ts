// DP-CORPUS — Grafana seeder (WU-CORPUS-06, live, cross-service).
// Pushes render_queue_metrics.csv via Prometheus remote-write (hand-encoded
// WriteRequest + vendored literal-only snappy framing), failed_jobs.jsonl via
// Loki push, then provisions dashboard.json + alert-rules.yaml. Idempotent:
// re-runs overwrite the same dashboard uid / ruler group in place.
// NOTE: metrics use a minimal valid snappy stream (literals only); the stack
// decodes it as standard snappy/xerial framing.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

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

// --- CRC32C (Castagnoli) + masked checksum for snappy framing ---
// Table-driven, reflected polynomial 0x82F63B78. Pure TS: no runtime dep.
const CRC32C_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

function crc32c(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC32C_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Snappy framing masks the checksum of each UNCOMPRESSED chunk:
// masked = ((crc >> 15) | (crc << 17)) + 0xa282ead8 (mod 2^32), little-endian.
function maskedCrc(chunk: Buffer): number[] {
  const c = crc32c(chunk);
  const m = (((c >>> 15) | (c << 17)) + 0xa282ead8) >>> 0;
  return [m & 0xff, (m >>> 8) & 0xff, (m >>> 16) & 0xff, (m >>> 24) & 0xff];
}

// --- minimal snappy framing (stream identifier + literal-only chunks) ---
function snappyCompress(raw: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00, 0x00, 0x00])];
  let offset = 0;
  while (offset < raw.length) {
    const chunk = raw.subarray(offset, Math.min(offset + 32768, raw.length));
    offset += chunk.length;
    // Chunk payload = 4-byte masked checksum, then the literal run (tag + bytes).
    const body: number[] = [...maskedCrc(chunk)];
    // single literal element header: (len-1)<<2 | 00, 60+ encoding for len>60
    const n = chunk.length;
    if (n <= 60) {
      body.push(((n - 1) << 2) | 0);
    } else {
      const lenBytes: number[] = [];
      let tmp = n - 1;
      while (tmp > 0) {
        lenBytes.push(tmp & 0xff);
        tmp >>= 8;
      }
      body.push((59 + lenBytes.length) << 2);
      body.push(...lenBytes);
    }
    body.push(...Array.from(chunk));
    const header = Buffer.alloc(4);
    header[0] = 0x00;
    const size = body.length;
    header[1] = size & 0xff;
    header[2] = (size >> 8) & 0xff;
    header[3] = (size >> 16) & 0xff;
    parts.push(header, Buffer.from(body));
  }
  return Buffer.concat(parts);
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
  const metrics = parseCsv(readFileSync(join(CORPUS, "telemetry", "render_queue_metrics.csv"), "utf8"));
  const logs = readFileSync(join(CORPUS, "telemetry", "failed_jobs.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);

  // Timestamp-shift rule (DP-CORPUS §6 FM-01): keep generation literals on disk;
  // shift in memory only when the window is older than retention.
  const maxTs = Math.max(...metrics.map((m) => Date.parse(m["ts"] as string)));
  let shiftMs = 0;
  if (Date.now() - maxTs > 30 * 24 * 3600 * 1000) {
    shiftMs = Date.now() - 2 * 3600 * 1000 - maxTs;
    console.log(`seed:grafana: shifted timestamps by ${Math.round(shiftMs / 1000)}s to fit retention`);
  }
  const tsOf = (iso: string): number => Date.parse(iso) + shiftMs;

  // 1) Metrics push: 500 samples per request.
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
    const body = snappyCompress(writeRequest(series));
    const first = batch[0] as Record<string, string>;
    const last = batch[batch.length - 1] as Record<string, string>;
    const fp = createHash("sha1").update(`${first["ts"]}${last["ts"]}${batch.length}`).digest("hex").slice(0, 12);
    void fp;
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
      `metrics batch ${i / BATCH}`,
    );
    await new Promise((r) => setTimeout(r, 250));
  }

  // 2) Logs push: 200 lines per request, grouped by vendor stream labels.
  const LOG_BATCH = 200;
  for (let i = 0; i < logs.length; i += LOG_BATCH) {
    const batch = logs.slice(i, i + LOG_BATCH);
    const byVendor = new Map<string, { ts: string; line: string }[]>();
    for (const line of batch) {
      const obj = JSON.parse(line) as { ts: string; job_id: string };
      const vendor = metrics.find((m) => m["job_id"] === obj.job_id)?.["vendor"] ?? "unknown";
      const arr = byVendor.get(vendor) ?? [];
      arr.push({ ts: obj.ts, line });
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

  // 3) Dashboard provision: GET-then-POST, overwrite in place.
  const dashboard = JSON.parse(readFileSync(join(ROOT, "grafana", "dashboard.json"), "utf8"));
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

  // 4) Alert rule provision: overwrite the same ruler group.
  const rulesYaml = readFileSync(join(ROOT, "grafana", "alert-rules.yaml"), "utf8");
  await req(
    `${base}/api/ruler/grafana/api/v1/rules/CineOps`,
    { method: "POST", headers: { "Content-Type": "application/yaml" }, body: rulesYaml },
    bearer,
    "alert rules",
  );

  console.log("seed:grafana: dashboard_uid=cineops-render-queue panel_id=1 provisioned");
  console.log(`seed:grafana: incident window ${manifest.incident_window.from} → ${manifest.incident_window.to}`);
}

await main();
