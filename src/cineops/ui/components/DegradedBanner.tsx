// CineOps Guardian — degraded banner (never dismissible mid-run).
import type { JSX } from "react";
export interface DegradedBannerProps {
  visible: boolean;
  reason: string;
}

export function DegradedBanner(props: DegradedBannerProps): JSX.Element | null {
  const { visible, reason } = props;
  if (!visible) return null;
  return (
    <div data-testid="degraded-banner" role="status" className="cineops-degraded-banner">
      Degraded: {reason} — showing fallback evidence.
    </div>
  );
}
