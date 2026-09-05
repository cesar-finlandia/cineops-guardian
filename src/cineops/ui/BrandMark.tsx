// CineOps Guardian — brand mark (clapper slate + render waveform), inline SVG.
import type { JSX } from "react";

export function BrandMark(): JSX.Element {
  return (
    <span className="cg-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
        <rect x="3" y="8" width="18" height="12" rx="2" fill="currentColor" opacity={0.18} />
        <rect x="3" y="8" width="18" height="12" rx="2" />
        <path d="M3 8l2-4h16l-2 4" />
        <path d="M8 4l2 4M13 4l2 4M18 4l2 4" />
        <path d="M8 13v4M12 13v2.5M16 13v4" strokeLinecap="round" />
      </svg>
    </span>
  );
}
