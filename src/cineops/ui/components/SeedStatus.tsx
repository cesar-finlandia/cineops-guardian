// CineOps Guardian — seed status widget (visual identity §6.1).
// Busy: animated reel + verb-led copy while POST /api/seed is in flight.
// Ready: green confirmation that stays in place with the next-step pointer.
// Error state is rendered by App.tsx as role="alert" (E2E golden-fallback
// asserts on it) — this widget renders nothing on error to avoid duplicates.
import type { JSX } from "react";
import { BusyDots } from "../widgets/RunLoader.js";

export interface SeedResult {
  shots: number;
  metrics: number;
}

export interface SeedStatusProps {
  seeding: boolean;
  result: SeedResult | null;
  error: string | null;
}

export function SeedStatus(props: SeedStatusProps): JSX.Element | null {
  const { seeding, result, error } = props;
  if (seeding) {
    return (
      <div className="cg-seed-status cg-seed-busy" role="status" data-testid="seed-status">
        <svg className="cg-seed-reel" viewBox="0 0 48 48" fill="none" aria-hidden="true">
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
        <div>
          <p className="cg-seed-title">
            Loading demo production
            <BusyDots />
          </p>
          <p className="cg-seed-detail">Seeding BigQuery, preparing the shot list and telemetry. Please wait.</p>
        </div>
      </div>
    );
  }
  if (error || !result) return null;
  return (
    <div className="cg-seed-status cg-seed-ready" role="status" data-testid="seed-status">
      <svg className="cg-seed-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="M8 12.5l2.5 2.5L16 9.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <p className="cg-seed-title">
          Demo data ready — {result.shots} shots, {result.metrics} metrics.
        </p>
        <p className="cg-seed-detail">Press Diagnose to run triage on tomorrow&apos;s dailies.</p>
      </div>
    </div>
  );
}
