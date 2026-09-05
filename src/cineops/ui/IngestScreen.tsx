// CineOps Guardian — ingest screen (DP-UI FR-01).
import type { JSX } from "react";
import { useState } from "react";
import type { CineOpsRunRequest } from "../types.js";
import { SeedStatus } from "./components/SeedStatus.js";
import type { SeedResult } from "./components/SeedStatus.js";

export interface IngestScreenProps {
  onStart: (req: CineOpsRunRequest, files?: File[]) => void;
  seeding: boolean;
  onSeed: () => void;
  seedResult?: SeedResult | null;
  seedError?: string | null;
}

export function IngestScreen(props: IngestScreenProps): JSX.Element {
  const { onStart, seeding, onSeed, seedResult = null, seedError = null } = props;
  const [production, setProduction] = useState("NEON HOLLOW");
  const [question, setQuestion] = useState("Which shots are blocked for tomorrow's dailies and why?");
  const [windowFrom, setWindowFrom] = useState("2026-09-04T14:00:00Z");
  const [windowTo, setWindowTo] = useState("2026-09-04T15:30:00Z");
  const [severity, setSeverity] = useState<"low" | "medium" | "high">("medium");
  const [files, setFiles] = useState<File[]>([]);

  return (
    <section className="cineops-ingest" data-screen="ingest">
      <div className="cg-hero">
        <p className="cg-eyebrow">Neon Hollow · Dailies triage</p>
        <h2>Which shots are blocked for tomorrow&apos;s dailies — and why?</h2>
        <p className="cg-lede">
          Ask in plain English. The agent queries live Grafana telemetry, joins it with your call sheets
          and delivery memos, and proposes a revised shot order with citations.
        </p>
      </div>
      <h2>Incident triage</h2>
      <label>
        Production
        <input type="text" value={production} onChange={(e) => setProduction(e.target.value)} />
      </label>
      <label>
        Question
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <label>
        Window start
        <input type="text" value={windowFrom} onChange={(e) => setWindowFrom(e.target.value)} />
      </label>
      <label>
        Window end
        <input type="text" value={windowTo} onChange={(e) => setWindowTo(e.target.value)} />
      </label>
      <label>
        Severity floor
        <select value={severity} onChange={(e) => setSeverity(e.target.value as "low" | "medium" | "high")}>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <label>
        Call sheets / memos (optional)
        <input
          type="file"
          multiple
          accept=".pdf,.csv"
          onChange={(e) => setFiles(e.target.files ? Array.from(e.target.files) : [])}
        />
      </label>
      <div className="cineops-ingest-actions">
        <button data-testid="seed-btn" disabled={seeding} onClick={onSeed}>
          {seeding ? "Loading…" : "Load demo production"}
        </button>
        <button
          data-testid="diagnose-btn"
          onClick={() =>
            onStart(
              {
                question,
                production,
                window_from: windowFrom,
                window_to: windowTo,
                severity_floor: severity,
                corpus: "demo",
                uploads: [],
                trace_id: null,
              },
              files,
            )
          }
        >
          Diagnose
        </button>
      </div>
      <SeedStatus seeding={seeding} result={seedResult} error={seedError} />
    </section>
  );
}
