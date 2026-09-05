# SPINUP — clean-clone to running service

1. `git clone <REPO_URL> && cd <REPO_DIR>`
2. `cp config/env.example .env` then fill `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `BQ_DATASET` (names only; never commit `.env`)
3. `npm ci`
4. `pip install -r requirements.txt` (or `pip install -e .` per DP-CONFIG dependency list)
5. `npm run gen:corpus`
6. `npm run seed:grafana`
7. `uvicorn engine.api.app:app --host 0.0.0.0 --port 8080`
8. `curl -s http://localhost:8080/api/health` → expected `{"ok":true,...}` (full shape in §5 step 6)

## Notes

- **Vertex AI only.** Gemini is reached through Vertex with Application Default
  Credentials (`gcloud auth application-default login`, or the Cloud Run service
  account). There is no API-key path: `GOOGLE_GENAI_USE_VERTEXAI=true` and a
  project/location are all the model needs. `GEMINI_MODEL` defaults to
  `gemini-2.5-flash`; the 2.0 ids are retired on Vertex.
- **Grafana MCP over stdio.** With `GRAFANA_TRANSPORT=stdio` the backend spawns
  the `grafana/mcp-grafana` binary. The container installs it on `PATH`; for a
  local run either put it on `PATH` or point `MCP_GRAFANA_BIN` at it. If it
  cannot be launched, `/api/health` reports `grafana_mcp.reachable:false` with
  the launch error and the run degrades honestly instead of failing.
- **Build the UI before serving.** `npm run build:ui` writes `dist/`, which the
  backend serves at `/`. `npm run dev` is the Vite dev server for UI work only.

## Re-running the E2E gate

The delivery gate that proves UC-01..UC-12 in a real browser lives in
`design_documents/e2e-testing/` (strategy in `STRATEGY.md`):

```bash
npm run build:ui
npx playwright test --config design_documents/e2e-testing/playwright.config.ts
```

Copy `design_documents/e2e-testing/.env.e2e.example` to `.env.e2e` and fill it
with local values first (Vertex project, Grafana URL + service-account token).
The config resolves the MCP binary itself (`E2E_MCP_GRAFANA_BIN`, then
`.e2e-bin/`, then `PATH`), so the suite does not depend on your shell.
