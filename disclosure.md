# Provenance & Disclosure

I have reused only platform level code from a past hackathon that implements:

- message buffer + pluggable token counter.
- Token/request metering + budget warnings

All other code is done for this hackathon.
Work flow is creating design plans via Claude AI and the implementation by a cheaper AI. Testing done also with Claude.

## AI tools used

Google Cloud AI tools: Gemini 2.5 Flash on Vertex AI via `google-genai`
(`engine/providers/gemini.py`) and the `google-adk` agent framework
(`engine/agents/agent.py`). Coding assistance was used for implementation.
No non-Google AI model, agent framework, or AI API is imported or called
(pointer: `scripts/hygiene.sh`).

Annotation writes use the Grafana HTTP API while all reads go through the MCP server.
