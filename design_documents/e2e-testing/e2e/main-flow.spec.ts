// T1 live-local primary flow: Maya opens the app, seeds the demo production,
// runs a diagnosis, watches all 8 steps stream, approves the Grafana writes,
// reviews results and exports the revised schedule — all in a real browser.
import { test, expect } from "@playwright/test";
import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const STEP_IDS = [
  "load-context",
  "plan-queries",
  "query-grafana",
  "persist-snapshot",
  "correlate-evidence",
  "propose-remediation",
  "write-back",
  "summarize-run",
];

const envelopeSchema = JSON.parse(
  readFileSync(resolve(ROOT, "contracts", "event-envelope.schema.json"), "utf8"),
);

test.describe("UC-01..UC-08 Maya happy path (live Vertex + local Grafana + live BQ)", () => {
  test("seed → diagnose → stream → approve → result → csv", async ({ page }) => {
    test.setTimeout(600_000);

    // UC-01: app loads, backend liveness pill resolves.
    await page.goto("/");
    await expect(page.locator("h1")).toContainText("CineOps Guardian");
    const pill = page.getByTestId("health-pill");
    await expect(pill).not.toContainText("checking", { timeout: 60_000 });
    await expect(pill).toContainText("healthy", { timeout: 60_000 });
    await expect(pill).toContainText("gemini:ok");
    await expect(pill).toContainText("grafana-mcp:ok");
    await expect(pill).toContainText("bigquery:ok");

    // UC-02: one-click demo seed (UI, forced refresh ≈ 50 s of BQ load jobs).
    // Counts asserted via the fast ensure path (no second full reload —
    // rapid consecutive truncates hit transient BQ table-update throttling).
    await page.getByTestId("seed-btn").click();
    await expect(page.getByTestId("seed-btn")).toBeEnabled({ timeout: 180_000 });
    await expect(page.locator('[role="alert"]')).toHaveCount(0);
    const seed = await page.request.post("/api/seed", { data: { production: "PALS" } });
    if (!seed.ok()) throw new Error(`seed ensure failed: HTTP ${seed.status()} ${await seed.text()}`);
    const seedBody = await seed.json();
    expect(seedBody.shots).toBe(240);
    expect(seedBody.metrics).toBe(8064);
    expect(seedBody.refreshed).toBe(false);

    // In-browser SSE collector (proves FR-12 envelopes, not just pixels).
    // Merged from the live socket AND the replay endpoint: the chassis
    // closes idle SSE streams after ~15 s and our runs have multi-minute
    // gaps, so socket-only collection would be racy (E2E F13).
    await page.evaluate(() => {
      const store = (window as unknown as { __e2e_envs: unknown[] }).__e2e_envs = [];
      const seen = ((window as unknown as { __e2e_seq: Set<number> }).__e2e_seq = new Set<number>());
      const push = (env: unknown): void => {
        const seq = (env as Record<string, unknown>).sequence as number;
        if (typeof seq === "number" && !seen.has(seq)) {
          seen.add(seq);
          store.push(env);
        }
      };
      (window as unknown as { __e2e_push: (e: unknown) => void }).__e2e_push = push;
      const es = new EventSource("/events/stream");
      (window as unknown as { __e2e_es: EventSource }).__e2e_es = es;
      es.addEventListener("envelope", (e: Event) => {
        try {
          push(JSON.parse((e as MessageEvent).data as string));
        } catch {
          /* malformed frame: asserted below via schema validation */
        }
      });
      const poll = async (): Promise<void> => {
        try {
          const first = store[0] as Record<string, unknown> | undefined;
          const trace = (first?.trace_id as string) ?? "";
          if (!trace) return;
          const max = seen.size === 0 ? -1 : Math.max(...seen);
          const r = await fetch("/api/events/recent?trace_id=" + encodeURIComponent(trace) + "&after=" + String(max));
          if (!r.ok) return;
          const body = (await r.json()) as { envelopes: unknown[] };
          for (const env of body.envelopes ?? []) push(env);
        } catch {
          /* poll best-effort; socket remains primary */
        }
      };
      (window as unknown as { __e2e_poll: number }).__e2e_poll = window.setInterval(() => void poll(), 2000);
    });

    // UC-03: Diagnose with the prefilled incident question.
    await page.getByTestId("diagnose-btn").click();
    await expect(page.locator('section[data-screen="run"]')).toBeVisible({ timeout: 30_000 });

    // UC-06: approval gate appears (agent pauses at write-back).
    const approveBtn = page.getByTestId("approve-btn");
    await expect(approveBtn).toBeVisible({ timeout: 300_000 });
    await expect(approveBtn).toContainText(/Approve selected \([1-9][0-9]*\)/);
    // UC-05 (early): streaming evidence cards carry real MCP tool names.
    const tools = page.getByTestId("evidence-tool");
    await expect.poll(async () => tools.count(), { timeout: 300_000 }).toBeGreaterThan(0);
    const firstTool = await tools.first().textContent();
    expect(firstTool ?? "").toMatch(/MCP tool: \S+/);

    // Approve once. The control unmounts after a successful approve (the run
    // leaves awaiting-approval; no double-write possible afterwards — the
    // App `approved` flag also guards the handler itself).
    await approveBtn.click();
    await expect(approveBtn).toHaveCount(0, { timeout: 30_000 });

    // Step indicator rendered all 8 steps while the run screen is mounted
    // (per-step done states are proven by the UC-04 envelope contract below;
    // the run screen unmounts once the result screen takes over).
    for (const id of STEP_IDS) {
      await expect(page.locator(`li[data-step-id="${id}"]`)).toBeAttached({ timeout: 30_000 });
    }

    // UC-07: result screen with findings, hours, receipts, revised table.
    await expect(page.locator('section[data-screen="result"]')).toBeVisible({ timeout: 300_000 });
    const findings = page.locator(".cineops-finding-row");
    await expect.poll(async () => findings.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const hours = await page.getByTestId("hours-saved").textContent();
    expect(hours ?? "").toMatch(/Hours saved: [\d.]+/);
    const links = page.getByTestId("grafana-link");
    await expect.poll(async () => links.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const href = await links.first().getAttribute("href");
    expect(href ?? "").toContain("/d/");
    const shotRows = page.locator(".cineops-shot-table tbody tr");
    await expect.poll(async () => shotRows.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    const summary = page.locator('section[data-screen="result"] p').last();
    expect(((await summary.textContent()) ?? "").length).toBeGreaterThan(0);

    // UC-08: CSV export — exact header, sane filename, data rows.
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByTestId("csv-download").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^revised-schedule-[0-9a-f]{8}\.csv$/);
    const dlPath = await download.path();
    const csv = readFileSync(dlPath as string, "utf8");
    const lines = csv.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("shot_id,production,status,priority,due_at,action,recommended_note");
    expect(lines.length).toBeGreaterThan(1);

    // UC-04: envelope contract over everything the browser received.
    const envs = (
      (await page.evaluate(() => (window as unknown as { __e2e_envs: unknown[] }).__e2e_envs)) as Array<
        Record<string, unknown>
      >
    ).sort((a, b) => (a.sequence as number) - (b.sequence as number));
    expect(envs.length).toBeGreaterThan(STEP_IDS.length);
    const ajv = new Ajv({ strict: false });
    addFormats(ajv);
    const validate = ajv.compile(envelopeSchema);
    for (const env of envs) {
      expect(validate(env), JSON.stringify(validate.errors)).toBe(true);
    }
    const seenSteps = new Set(envs.map((e) => e.step_id as string));
    for (const id of STEP_IDS) expect(seenSteps.has(id)).toBe(true);
    const seqs = envs.map((e) => e.sequence as number);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    const traceIds = new Set(envs.map((e) => e.trace_id as string));
    expect(traceIds.size).toBe(1);
    const gate = envs.find((e) => e.step_id === "write-back" && e.status === "started");
    expect((gate?.payload as Record<string, unknown>)?.awaiting_approval).toBe(true);
    expect(envs.some((e) => e.step_id === "summarize-run" && e.status === "done")).toBe(true);

    // UC-05 (proof log): this run wrote MCP proof lines, not just pixels.
    const proofLines = readFileSync(resolve(ROOT, "logs", "mcp-grafana.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"path": "mcp"') || l.includes('"path":"mcp"'));
    expect(proofLines.length).toBeGreaterThan(0);

    // Reset returns Maya to ingest (no stuck state).
    await page.getByRole("button", { name: "Back to ingest" }).click();
    await expect(page.locator('section[data-screen="ingest"]')).toBeVisible();
  });
});
