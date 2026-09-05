// UC-12 offline honesty (T0): backend booted with RES_FORCED_DEGRADED=1 and no
// cloud creds must still serve the app and complete a full run degraded — the
// on-stage fallback rung. Spawns its own server on :8081 (Playwright webServer
// owns :8080 for the T1 specs).
import { test, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BASE = "http://127.0.0.1:8081";
let server: ChildProcess | null = null;

test.describe("UC-12 golden/offline fallback (forced degraded, no creds)", () => {
  test.beforeAll(async () => {
    server = spawn("python3", ["-m", "uvicorn", "engine.api.app:app", "--host", "127.0.0.1", "--port", "8081", "--timeout-keep-alive", "75"], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        RES_FORCED_DEGRADED: "1",
        PYTHONUTF8: "1",
        PYTHONIOENCODING: "utf-8",
      },
    });
    // Wait for the seam (startup must not hang — F1 regression).
    const start = Date.now();
    for (;;) {
      try {
        const res = await fetch(`${BASE}/api/health`);
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() - start > 120_000) throw new Error("T0 server did not boot in 120s");
      await new Promise((r) => setTimeout(r, 2000));
    }
  });

  test.afterAll(async () => {
    if (server) {
      server.kill();
      server = null;
    }
  });

  test("boots degraded, runs to done with banner, no blank screen", async ({ page }) => {
    test.setTimeout(600_000);

    const health = await page.request.get(`${BASE}/api/health`);
    expect(health.ok()).toBe(true);
    const h = (await health.json()) as Record<string, unknown>;
    expect(h.ok).toBe(false);
    expect(h.degraded).toBe(true);

    await page.goto(`${BASE}/`);
    await expect(page.locator("h1")).toContainText("CineOps Guardian");

    // Seed provisions BigQuery → honestly 502 offline; the app must SAY so
    // and still let Maya diagnose from the local corpus (F-fix reasoning).
    await page.getByTestId("seed-btn").click();
    await expect(page.getByTestId("seed-btn")).toBeEnabled({ timeout: 60_000 });
    await expect(page.locator('[role="alert"]')).toContainText("Seed degraded", { timeout: 30_000 });

    await page.getByTestId("diagnose-btn").click();
    await expect(page.locator('section[data-screen="run"]')).toBeVisible({ timeout: 30_000 });

    // Full degraded run still reaches the result screen (no gate stall: the
    // approval control renders even with zero actions).
    const approveBtn = page.getByTestId("approve-btn");
    await expect(approveBtn).toBeVisible({ timeout: 300_000 });
    await approveBtn.click();
    await expect(page.locator('section[data-screen="result"]')).toBeVisible({ timeout: 300_000 });

    // Honest fallback artefacts: banner, pure-Python findings, no actions.
    await expect(page.getByTestId("degraded-banner")).toBeVisible();
    const findings = page.locator(".cineops-finding-row");
    await expect.poll(async () => findings.count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await expect(page.getByTestId("csv-download")).toBeDisabled();
  });
});
