# Plan Grafana queries

Convert the coordinator question into a QueryPlan of typed, scoped Grafana MCP operations.
Constraints: at most MAX_PLAN_STEPS steps; each step has step_no, kind (metrics | logs | traces | dashboards | alerts | incidents), tool_hint, args, why; window_from/window_to bound every step; cover the incident window first, then supporting context; never emit Grafana HTTP calls.
Question: {{question}}
Window: {{window_from}} to {{window_to}}
Return a JSON object matching the query-plan schema.
