# DEPLOY — CineOps Guardian (Cloud Run)

- PUBLIC_URL: https://cineops-guardian-7h3vdn6jtq-uc.a.run.app
- Service: `cineops-guardian`, region: `us-central1`, project: `hacka-2026-09-agentic-cinema2` (deployed 2026-09-07, revision 00003; health `ok:true`, Grafana MCP 81 tools via stdio)
- Image: built from repo-root `Dockerfile` via `gcloud run deploy --source .`
- Reproduction:
  1. `PROJECT_ID=<id> REGION=<region> npm run deploy:cloudrun`
  2. `curl -s "$PUBLIC_URL/api/health" | python3 -m json.tool`
  3. `PUBLIC_URL=<url> npx tsx scripts/smoke-deploy.ts`
- IAM roles on the service account (see §5 step 3): Vertex AI user, BigQuery data editor, BigQuery job user, Secret Manager secret accessor.
- Secret Manager secrets: `grafana-service-account-token` (→ `GRAFANA_SERVICE_ACCOUNT_TOKEN`). Non-secret env: `GRAFANA_STACK_URL`, `GRAFANA_MCP_URL`, `GRAFANA_TRANSPORT`.
- Gemini env set by the deploy script (Vertex AI + ADC, **no API key anywhere**):
  `GOOGLE_GENAI_USE_VERTEXAI=true`, `GOOGLE_CLOUD_PROJECT=$PROJECT_ID`,
  `GOOGLE_CLOUD_LOCATION` (defaults to `$REGION`), `GEMINI_MODEL` (defaults to
  `gemini-2.5-flash` — the 2.0 ids are retired on Vertex), `BQ_DATASET`
  (defaults to `cineops`). Override any of them by exporting it before the
  deploy. `GOOGLE_GENAI_USE_VERTEXAI` in particular is not optional: without
  it `google-adk` falls back to AI-Studio/API-key mode and every model call
  fails on Cloud Run.
- Before the first deploy: create the secret
  (`gcloud secrets create grafana-service-account-token --data-file=-`) and set
  `region`/`project`/`service_account` in `config/deploy/cloudrun.json`.
