import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// Minimal .env parser (avoids a new dependency): operator-local secrets live in
// design_documents/e2e-testing/.env.e2e (never committed), KEY=VALUE per line.
function loadLocalEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}
const localEnv = loadLocalEnv(resolve(here, ".env.e2e"));
const pick = (k: string, fb = ""): string => process.env[k] ?? localEnv[k] ?? fb;

// E2E F19: the engine launches the Grafana MCP server over stdio by name, so a
// shell whose PATH lacks the binary silently yields grafana-mcp:unreachable and
// an all-degraded run. Resolve it here — explicit override first, then the
// repo-local download dir, then PATH — so the gate is reproducible from any
// shell (and any judge following docs/SPINUP.md).
const REPO = resolve(here, "..", "..");
function resolveMcpBin(): string {
  const explicit = pick("E2E_MCP_GRAFANA_BIN") || pick("MCP_GRAFANA_BIN");
  if (explicit) return explicit;
  for (const candidate of ["mcp-grafana.exe", "mcp-grafana"]) {
    const p = resolve(REPO, ".e2e-bin", candidate);
    if (existsSync(p)) return p;
  }
  return "mcp-grafana";
}

const E2E_ENV: Record<string, string> = {
  GOOGLE_CLOUD_PROJECT: pick("E2E_GOOGLE_CLOUD_PROJECT"),
  GOOGLE_CLOUD_LOCATION: pick("E2E_GOOGLE_CLOUD_LOCATION", "us-central1"),
  GOOGLE_GENAI_USE_VERTEXAI: "true",
  GEMINI_MODEL: pick("E2E_GEMINI_MODEL", "gemini-2.5-flash"),
  GRAFANA_STACK_URL: pick("E2E_GRAFANA_STACK_URL"),
  GRAFANA_SERVICE_ACCOUNT_TOKEN: pick("E2E_GRAFANA_SERVICE_ACCOUNT_TOKEN"),
  GRAFANA_TRANSPORT: pick("E2E_GRAFANA_TRANSPORT", "stdio"),
  MCP_GRAFANA_BIN: resolveMcpBin(),
  BQ_DATASET: pick("E2E_BQ_DATASET", "cineops"),
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 600_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1, // one backend, one run at a time (global SSE hub, single approval gate)
  reporter: [["list"], ["html", { open: "never", outputFolder: "./playwright-report" }]],
  outputDir: "./test-results",
  use: {
    baseURL: "http://127.0.0.1:8080",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    // --timeout-keep-alive matches the container CMD: uvicorn's 5 s default
    // races clients polling on a ~5 s cadence and kills the request with
    // ECONNRESET (E2E F21).
    command: "python3 -m uvicorn engine.api.app:app --host 127.0.0.1 --port 8080 --timeout-keep-alive 75",
    url: "http://127.0.0.1:8080/api/health",
    cwd: resolve(here, "..", ".."),
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
    env: E2E_ENV,
  },
});
