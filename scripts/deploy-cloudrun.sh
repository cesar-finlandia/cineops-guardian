#!/bin/bash
# CineOps Guardian — Cloud Run deploy (DP-DEPLOY §3.3).
# Usage: PROJECT_ID=<gcp-project> REGION=<region> ./scripts/deploy-cloudrun.sh
#   e.g. PROJECT_ID=cineops-guardian REGION=us-central1 npm run deploy:cloudrun
# Only PROJECT_ID and REGION are operator-supplied; everything else comes from
# config/deploy/cloudrun.json. Never pass a secret value on the command line.
set -euo pipefail
CONFIG="config/deploy/cloudrun.json"
SERVICE=$(python3 -c "import json;print(json.load(open('$CONFIG'))['service'])")
REGION="${REGION:-$(python3 -c "import json;print(json.load(open('$CONFIG'))['region'])")}"
PROJECT_ID="${PROJECT_ID:-$(python3 -c "import json;print(json.load(open('$CONFIG'))['project'])")}"
MEMORY=$(python3 -c "import json;print(json.load(open('$CONFIG'))['memory'])")
CPU=$(python3 -c "import json;print(json.load(open('$CONFIG'))['cpu'])")
TIMEOUT=$(python3 -c "import json;print(json.load(open('$CONFIG'))['timeout_seconds'])")
SERVICE_ACCOUNT=$(python3 -c "import json;print(json.load(open('$CONFIG'))['service_account'])")
if [ -z "$PROJECT_ID" ] || [ "$PROJECT_ID" = "REPLACE_WITH_PROJECT_ID" ]; then
  echo "ERROR: set PROJECT_ID env var (your GCP project id)." >&2; exit 1
fi
if [ -z "$REGION" ] || [ "$REGION" = "REPLACE_WITH_REGION" ]; then
  echo "ERROR: set REGION env var (e.g. us-central1)." >&2; exit 1
fi
# One-time BigQuery provisioning (DP-BQ): ensure dataset exists before traffic.
python3 -c "from engine.bq.loader import ensure_dataset; ensure_dataset()"
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --source . \
  --allow-unauthenticated \
  --min-instances=1 \
  --cpu "$CPU" \
  --memory "$MEMORY" \
  --timeout "$TIMEOUT" \
  --service-account "$SERVICE_ACCOUNT" \
  --set-env-vars "GRAFANA_STACK_URL=${GRAFANA_STACK_URL},GRAFANA_MCP_URL=${GRAFANA_MCP_URL},GRAFANA_TRANSPORT=${GRAFANA_TRANSPORT:-sse}" \
  --set-secrets "GRAFANA_SERVICE_ACCOUNT_TOKEN=grafana-service-account-token:latest"
URL=$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')
echo "PUBLIC_URL=$URL"
# Warm-up: exactly 3 GET /api/health pings, each must print HTTP 200 (see §5 step 5).
for i in 1 2 3; do curl -s -o /dev/null -w "%{http_code} %{url_effective}\\n" "$URL/api/health"; sleep 2; done
