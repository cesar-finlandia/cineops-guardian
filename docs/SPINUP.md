# SPINUP — clean-clone to running service

1. `git clone <REPO_URL> && cd <REPO_DIR>`
2. `cp config/env.example .env` then fill `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `GRAFANA_URL`, `GRAFANA_SERVICE_ACCOUNT_TOKEN`, `BQ_DATASET` (names only; never commit `.env`)
3. `npm ci`
4. `pip install -r requirements.txt` (or `pip install -e .` per DP-CONFIG dependency list)
5. `npm run gen:corpus`
6. `npm run seed:grafana`
7. `uvicorn engine.api.app:app --host 0.0.0.0 --port 8080`
8. `curl -s http://localhost:8080/api/health` → expected `{"ok":true,...}` (full shape in §5 step 6)
