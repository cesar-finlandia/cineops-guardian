// CineOps Guardian — loading widgets (visual identity §6.1).
// Every async action renders one of these with verb-led copy + elapsed time.
// Pure CSS/SVG motion; honors prefers-reduced-motion via stylesheet.
import type { JSX } from "react";
import { useEffect, useState } from "react";

export interface RunLoaderProps {
  step: string;
  detail?: string;
  progress?: number | null;
  waiting?: boolean;
}

function ReelIcon(): JSX.Element {
  return (
    <svg className="cg-reel" viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <circle cx="24" cy="24" r="21" stroke="currentColor" strokeWidth={3} />
      <circle cx="24" cy="24" r="5" fill="currentColor" />
      {[0, 60, 120, 180, 240, 300].map((deg) => (
        <circle
          key={deg}
          cx={24 + 13 * Math.cos((deg * Math.PI) / 180)}
          cy={24 + 13 * Math.sin((deg * Math.PI) / 180)}
          r="4"
          fill="currentColor"
          opacity={0.85}
        />
      ))}
    </svg>
  );
}

export function BusyDots(): JSX.Element {
  return (
    <span className="cg-dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function RenderBar(): JSX.Element {
  return (
    <div className="cg-progress" role="progressbar" aria-label="Working">
      <div className="cg-progress-indeterminate" />
    </div>
  );
}

export function RunLoader(props: RunLoaderProps): JSX.Element {
  const { step, detail, progress = null, waiting = false } = props;
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t0 = Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  const pct = typeof progress === "number" && Number.isFinite(progress) ? Math.max(0, Math.min(100, progress)) : null;

  return (
    <div className={waiting ? "cg-loader cg-loader-waiting" : "cg-loader"} role="status" data-testid="run-loader">
      <ReelIcon />
      <div className="cg-loader-body">
        <p className="cg-loader-step">
          {step}
          <BusyDots />
        </p>
        {detail ? <p className="cg-loader-detail">{detail}</p> : null}
        {pct !== null ? (
          <div className="cg-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="cg-progress-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <RenderBar />
        )}
        <div className="cg-loader-meta">elapsed {elapsed}s · CineOps Guardian</div>
      </div>
    </div>
  );
}
