# Plan Grafana queries

Convert the coordinator question into a QueryPlan of typed, scoped Grafana MCP operations.
Constraints: at most MAX_PLAN_STEPS steps; window_from/window_to bound every step; cover the incident window first, then supporting context; never emit Grafana HTTP calls.
Question: {{question}}
Window: {{window_from}} to {{window_to}}

Known inventory — use these verbatim; never invent metric names, label names, or dashboard UIDs:
{{inventory}}

STRICT SHAPE (the plan is schema-validated; violations are discarded):
- Top-level object keys EXACTLY: plan_id (string), question (string), window_from (string), window_to (string), steps (array). Echo the Question/Window values above.
- Each step object has EXACTLY these keys: step_no (integer starting at 1), kind (one of metrics | logs | traces | dashboards | alerts | incidents), tool_hint (string, e.g. search_dashboards), args (OBJECT, never a bare string), why (string).
- Do NOT put window_from/window_to or any other keys inside a step.
- args is always an object. Metrics example: {"query": "cineops_render_queue_latency_seconds"}. Logs example: {"query": "{production=\"PALS\"} |= \"failed\""}. Dashboards example: {"query": "cineops"}.
Return a JSON object matching the query-plan schema.
