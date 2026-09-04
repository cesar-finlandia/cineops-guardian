// CineOps Guardian — approval control (DP-UI A4).
import type { JSX } from "react";
import { useState } from "react";
import type { CineOpsRemediationAction } from "../../types.js";

export interface ActionApprovalProps {
  actions: CineOpsRemediationAction[];
  disabled: boolean;
  approving: boolean;
  onApprove: (ids: string[]) => void;
}

export function ActionApproval(props: ActionApprovalProps): JSX.Element {
  const { actions, disabled, approving, onApprove } = props;
  const [checked, setChecked] = useState<Set<string>>(new Set(actions.map((a) => a.action_id)));

  const toggle = (id: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <section className="cineops-approval" aria-label="Approve Grafana writes">
      {actions.map((a) => (
        <label key={a.action_id}>
          <input type="checkbox" checked={checked.has(a.action_id)} disabled={disabled} onChange={() => toggle(a.action_id)} />
          {a.action_id} — {a.kind}
        </label>
      ))}
      <div className="cineops-approval-actions">
        <button data-testid="approve-btn" disabled={disabled || approving} onClick={() => onApprove([...checked])}>
          Approve selected ({checked.size})
        </button>
        <button data-testid="reject-btn" disabled={disabled || approving} onClick={() => onApprove([])}>
          Reject all
        </button>
      </div>
    </section>
  );
}
