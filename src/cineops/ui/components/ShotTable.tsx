// CineOps Guardian — revised shot priority table.
import type { JSX } from "react";
import type { CineOpsProductionShot } from "../../types.js";

export interface ShotTableProps {
  shots: CineOpsProductionShot[];
  /** Shot ids that block dailies — highlighted so Maya reads the fix first. */
  blockedIds?: string[];
}

export function ShotTable(props: ShotTableProps): JSX.Element {
  const { shots, blockedIds = [] } = props;
  const blocked = new Set(blockedIds);
  // Reprioritized (lowest number = render first) on top so the fix reads as
  // an ordered work list, not an alphabetical inventory.
  const ordered = [...shots].sort((a, b) => a.priority - b.priority || a.shot_id.localeCompare(b.shot_id));
  return (
    <table className="cineops-shot-table">
      <thead>
        <tr>
          <th>shot</th>
          <th>status</th>
          <th>priority</th>
          <th>due</th>
          <th>vendor</th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((s) => (
          <tr key={s.shot_id} data-blocked={blocked.has(s.shot_id) ? "true" : undefined}>
            <td>
              {blocked.has(s.shot_id) ? "⛔ " : ""}
              {s.shot_id}
            </td>
            <td>{s.status}</td>
            <td>{s.priority}</td>
            <td>{s.due_at}</td>
            <td>{s.vfx_vendor ?? ""}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
