# DEPLOY — CineOps Guardian (Cloud Run)

- PUBLIC_URL: https://cineops-guardian-<hash>-uc.a.run.app  <!-- filled by WU-DEPLOY-04 -->
- Service: `cineops-guardian`, region: `<region>`, project: `<project-id>`
- Image: built from repo-root `Dockerfile` via `gcloud run deploy --source .`
- Reproduction:
  1. `PROJECT_ID=<id> REGION=<region> npm run deploy:cloudrun`
  2. `curl -s "$PUBLIC_URL/api/health" | python3 -m json.tool`
  3. `PUBLIC_URL=<url> npx tsx scripts/smoke-deploy.ts`
- IAM roles on the service account (see §5 step 3): Vertex AI user, BigQuery data editor, BigQuery job user, Secret Manager secret accessor.
- Secret Manager secrets: `grafana-service-account-token` (→ `GRAFANA_SERVICE_ACCOUNT_TOKEN`). Non-secret env: `GRAFANA_STACK_URL`, `GRAFANA_MCP_URL`, `GRAFANA_TRANSPORT`.
