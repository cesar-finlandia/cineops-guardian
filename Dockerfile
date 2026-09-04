# CineOps Guardian — Cloud Run image (DP-DEPLOY §3.1).
# Stage 1 (node:20) builds the frontend to dist/. Stage 2 (python:3.11-slim)
# serves the API + static dist/ via uvicorn engine.api.app:app on $PORT.
# Only PROJECT_ID and REGION are operator-supplied (passed at deploy time,
# never baked in). No secrets appear in any layer (NFR-06).
FROM node:20 AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . ./
RUN npm run build:ui

FROM python:3.11-slim AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PORT=8080
WORKDIR /app
# System deps: curl for health pings; ca-certificates for TLS to Grafana/Vertex.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY pyproject.toml ./
# NOTE: src/ must exist before the editable install (setuptools src-layout).
COPY src/ ./src/
RUN pip install --no-cache-dir -e .
# App + chassis modules the backend imports + static assets.
COPY engine/ ./engine/
COPY src/ ./src/
COPY contracts/ ./contracts/
COPY config/ ./config/
COPY grafana/ ./grafana/
COPY --from=frontend /build/dist/ ./dist/
# logs/ holds the MCP proof log and is deliberately committed (not git-ignored);
# it must exist and be writable in the container.
RUN mkdir -p logs && chmod 777 logs
# stdio transport support (DP-MCP): when GRAFANA_TRANSPORT=stdio, the backend
# spawns the grafana/mcp-grafana binary. Install it only in that case; the
# script no-ops (prints a line, exits 0) when the transport is sse/streamable-http.
COPY grafana/install-mcp-binary.sh /tmp/install-mcp-binary.sh
RUN chmod +x /tmp/install-mcp-binary.sh && /tmp/install-mcp-binary.sh
EXPOSE 8080
CMD ["sh", "-c", "uvicorn engine.api.app:app --host 0.0.0.0 --port $PORT"]
