#!/bin/sh
# CineOps Guardian — conditional mcp-grafana binary install (DP-DEPLOY §3.1 NOTE).
# Installs the pinned grafana/mcp-grafana release only when the stdio transport
# is in use; otherwise prints a line and exits 0 (image stays lean).
set -eu
TRANSPORT="${GRAFANA_TRANSPORT:-}"
if [ -f /app/grafana/.transport ]; then
  TRANSPORT="$(cat /app/grafana/.transport)"
fi
if [ "$TRANSPORT" = "stdio" ]; then
  echo "install-mcp-binary: stdio transport — installing mcp-grafana..."
  VER="v0.6.0"
  ARCH="linux_amd64"
  URL="https://github.com/grafana/mcp-grafana/releases/download/${VER}/mcp-grafana_${ARCH}.tar.gz"
  curl -fsSL "$URL" -o /tmp/mcp-grafana.tar.gz
  tar -xzf /tmp/mcp-grafana.tar.gz -C /tmp
  mv /tmp/mcp-grafana /usr/local/bin/mcp-grafana
  chmod +x /usr/local/bin/mcp-grafana
  rm -f /tmp/mcp-grafana.tar.gz
  echo "install-mcp-binary: installed $(mcp-grafana --version 2>/dev/null || echo mcp-grafana)"
else
  echo "sse transport — skipping mcp-grafana binary"
fi
