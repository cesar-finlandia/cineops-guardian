// CineOps Guardian — revised shot priority table.
import type { JSX } from "react";
import type { CineOpsProductionShot } from "../../types.js";

export interface ShotTableProps {
  shots: CineOpsProductionShot[];
}

export function ShotTable(props: ShotTableProps): JSX.Element {
  const { shots } = props;
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
        {shots.map((s) => (
          <tr key={s.shot_id}>
            <td>{s.shot_id}</td>
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
