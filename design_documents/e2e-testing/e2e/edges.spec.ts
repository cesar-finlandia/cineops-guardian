// UC-09..UC-11: reject path, upload validation, API edge contract.
// Runs against the same T1 backend through the browser's request context.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function pollResult(
  request: import("@playwright/test").APIRequestContext,
  traceId: string,
  want: (body: Record<string, unknown>) => boolean,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  let transportErrors = 0;
  for (;;) {
    // A polling client must survive an idle keep-alive connection being
    // closed under it (ECONNRESET) — browsers retry idempotent GETs on a
    // reused connection, APIRequestContext does not. Retry, and only give up
    // if it keeps happening, which would mean the server really is gone
    // (E2E F21; the server side raised --timeout-keep-alive so the two
    // cadences stop colliding in the first place).
    let body: Record<string, unknown>;
    try {
      const res = await request.get(`/api/result/${traceId}`);
      expect(res.ok()).toBe(true);
      body = (await res.json()) as Record<string, unknown>;
      transportErrors = 0;
    } catch (err) {
      if (++transportErrors > 3 || Date.now() - start > timeoutMs) throw err;
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    if (want(body)) return body;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for result state: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 4000));
  }
}

test.describe("approval-reject + upload + edge contract (T1)", () => {
  test("UC-09 reject-all still completes the run with zero writes", async ({ page }) => {
    test.setTimeout(600_000);
    const run = await page.request.post("/api/run", {
      data: {
        question: "Which shots are blocked for tomorrow's dailies and why?",
        production: "PALS",
        window_from: "2026-09-04T14:00:00Z",
        window_to: "2026-09-04T15:30:00Z",
        severity_floor: "medium",
        corpus: "demo",
        uploads: [],
        trace_id: null,
      },
    });
    expect(run.ok()).toBe(true);
    const { trace_id } = (await run.json()) as { trace_id: string };

    const awaiting = await pollResult(
      page.request,
      trace_id,
      (b) => b.status === "awaiting-approval",
      300_000,
    );
    expect(Array.isArray(awaiting.actions)).toBe(true);

    const deny = await page.request.post("/api/approve", { data: { trace_id, action_ids: [] } });
    expect(deny.ok()).toBe(true);
    expect(((await deny.json()) as { released: number }).released).toBe(0);

    const done = await pollResult(page.request, trace_id, (b) => typeof b.trace_id === "string", 300_000);
    expect((done.receipts as unknown[]).length).toBe(0);

    // UC-11 double-approve guard: second release after completion is a no-op.
    const again = await page.request.post("/api/approve", { data: { trace_id, action_ids: ["a-1"] } });
    expect(again.ok()).toBe(true);
    expect(((await again.json()) as { released: number }).released).toBe(0);
  });

  test("UC-10 upload validation (csv ok, txt rejected, oversize rejected)", async ({ page }) => {
    const csvBytes = readFileSync(resolve(ROOT, "engine", "rag", "corpus", "shots", "shot_list.csv"));

    const okRes = await page.request.post("/api/upload", {
      multipart: { trace_id: "e2e-probe", files: { name: "shot_list.csv", mimeType: "text/csv", buffer: csvBytes } },
    });
    expect(okRes.ok()).toBe(true);
    const okBody = (await okRes.json()) as { paths: string[] };
    expect(okBody.paths.length).toBe(1);
    expect(okBody.paths[0]).toContain("e2e-probe");

    const txtRes = await page.request.post("/api/upload", {
      multipart: { trace_id: "e2e-probe", files: { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") } },
    });
    expect(txtRes.status()).toBe(400);

    const bigRes = await page.request.post("/api/upload", {
      multipart: {
        trace_id: "e2e-probe",
        files: { name: "big.csv", mimeType: "text/csv", buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 97) },
      },
    });
    expect(bigRes.status()).toBe(413);
  });

  test("UC-11 unknown trace + health shape", async ({ page }) => {
    const r1 = await page.request.get("/api/result/does-not-exist");
    expect(r1.status()).toBe(404);
    const r2 = await page.request.post("/api/approve", { data: { trace_id: "does-not-exist", action_ids: [] } });
    expect(r2.status()).toBe(404);

    // UI file picker only offers what the server accepts (F2 regression).
    await page.goto("/");
    const accept = await page.locator('input[type="file"]').getAttribute("accept");
    expect(accept).toBe(".pdf,.csv");

    // The pill is a polled liveness signal, so assert it the way the UI reads
    // it: it must report healthy within one poll window. A dependency that is
    // genuinely down never recovers here; a single blip self-heals (negative
    // health results carry a 5 s TTL — E2E F16).
    let h: Record<string, Record<string, unknown> | boolean> = {};
    await expect
      .poll(
        async () => {
          const res = await page.request.get("/api/health");
          if (!res.ok()) return false;
          h = (await res.json()) as Record<string, Record<string, unknown> | boolean>;
          return h.ok === true;
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe(true);
    for (const key of ["ok", "gemini", "grafana_mcp", "bigquery", "cost", "degraded"]) {
      expect(h).toHaveProperty(key);
    }
    expect((h.gemini as Record<string, unknown>).reachable).toBe(true);
    expect((h.bigquery as Record<string, unknown>).reachable).toBe(true);
    expect((h.grafana_mcp as Record<string, unknown>).reachable).toBe(true);
    expect(h.ok).toBe(true);
  });
});
