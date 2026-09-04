// CineOps Guardian — evidence card (DP-UI hard track-gate proof card).
import type { JSX } from "react";
export interface EvidenceCardProps {
  mcp_tool: string;
  kind: string;
  rows: number;
  took_ms: number;
}

export function EvidenceCard(props: EvidenceCardProps): JSX.Element {
  const { mcp_tool, kind, rows, took_ms } = props;
  return (
    <article className="cineops-evidence-card">
      <strong data-testid="evidence-tool">MCP tool: {mcp_tool}</strong>
      <span>kind: {kind}</span>
      <span>rows: {rows}</span>
      <span>took: {took_ms} ms</span>
    </article>
  );
}
