#!/bin/sh
# CineOps Guardian — mcp-grafana binary install (DP-DEPLOY §3.1 NOTE).
# Installs the pinned grafana/mcp-grafana release into the image by default.
#
# It used to install only when GRAFANA_TRANSPORT was already "stdio" at BUILD
# time — but nothing set that (Cloud Run's `gcloud run deploy --source .` has no
# way to pass a build arg), so the binary was never present and the engine's
# `auto` transport could not do the stdio fallback it advertises: one hiccup on
# the hosted MCP endpoint and the judge-facing service degrades with no way back
# (E2E F22). ~30 MB on a 2Gi service is a fair price for the fallback actually
# existing. Set INSTALL_MCP_BINARY=0 at build time to keep the image lean.
set -eu
if [ "${INSTALL_MCP_BINARY:-1}" != "0" ]; then
  echo "install-mcp-binary: installing mcp-grafana (stdio transport support)..."
  # v1.3.0 is the exact version the E2E gate drives locally, so the container
  # runs what was proven. The old pin (v0.6.0 / linux_amd64) 404s — the asset
  # naming is Linux_x86_64 — and was never noticed because the condition above
  # always took the skip branch (E2E F22).
  VER="v1.3.0"
  ARCH="Linux_x86_64"
  URL="https://github.com/grafana/mcp-grafana/releases/download/${VER}/mcp-grafana_${ARCH}.tar.gz"
  curl -fsSL "$URL" -o /tmp/mcp-grafana.tar.gz
  tar -xzf /tmp/mcp-grafana.tar.gz -C /tmp
  mv /tmp/mcp-grafana /usr/local/bin/mcp-grafana
  chmod +x /usr/local/bin/mcp-grafana
  rm -f /tmp/mcp-grafana.tar.gz
  echo "install-mcp-binary: installed $(mcp-grafana --version 2>/dev/null || echo mcp-grafana)"
else
  echo "install-mcp-binary: INSTALL_MCP_BINARY=0 — skipping mcp-grafana binary"
fi
