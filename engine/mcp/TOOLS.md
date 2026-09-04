# Grafana MCP tools (discovery pending live stack)
- transport: pending (pinned; settings.grafana_transport=auto)
- endpoint: <set GRAFANA_MCP_URL>
- stack: <set GRAFANA_STACK_URL>
- tool_count: 0
## tools
- (run WU-MCP-01 against the live Grafana Cloud stack to populate)
## resolution
- metrics -> `none(rest-fallback)`; logs -> `none(rest-fallback)`; traces -> `none(rest-fallback)`; dashboards -> `none(rest-fallback)`;
  alerts -> `none(rest-fallback)`; incidents -> `none(rest-fallback)`; annotation -> `none(rest-fallback)`;
  incident-note -> `none(rest-fallback)`
- BLOCKER: live Grafana Cloud stack credentials absent — discovery (WU-MCP-01..06) not yet run. This file will be overwritten by _write_tools_md on first live discovery.
