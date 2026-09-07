// CineOps Guardian — in-app industry primer (video support).
// A prominent header button ("How dailies work") opening a beginner-friendly
// dialog that explains the post-production world, the pain, and how the app
// helps. Self-contained: owns its open state, no App logic changes beyond
// rendering <IndustryGuide />. New testids only (industry-guide-btn,
// industry-guide, industry-guide-close); existing e2e contracts untouched.
import type { JSX } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

function InfoIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}

export function IndustryGuide(): JSX.Element {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open ]);

  return (
    <>
      <button
        type="button"
        className="cg-guide-btn"
        data-testid="industry-guide-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <InfoIcon />
        <span>How dailies work</span>
      </button>
      {open
        ? createPortal(
            <div className="cg-guide-scrim" data-testid="industry-guide" onClick={() => setOpen(false)}>
          <div
            ref={dialogRef}
            className="cg-guide-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cg-guide-title"
            tabIndex={-1}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cg-guide-head">
              <div>
                <p className="cg-eyebrow">New to post-production? Start here</p>
                <h2 id="cg-guide-title">How dailies work — the 5-minute industry primer</h2>
              </div>
              <button
                type="button"
                className="cg-guide-close"
                data-testid="industry-guide-close"
                aria-label="Close guide"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="cg-guide-body">
              <section>
                <h3>1. PALS: from a warehouse stage to your screen</h3>
                <p>
                  PALS is a fictional no-budget indie ensemble comedy — six friends, one
                  coffeehouse set, fifteen people making it. Like every show it is built in
                  two phases. First comes the <strong>shoot</strong>: actors perform scenes
                  on a stage while the crew films them. The day runs off a{" "}
                  <strong>call sheet</strong> — a one-page plan saying who must be where
                  and when (see <code>examples/PALS-call-sheet-day12.md</code>: Day 12 of
                  24, coffeehouse scenes in the morning, rooftop at sunset). When the shoot
                  wraps, the footage is just raw material.
                </p>
                <p>
                  Then comes <strong>post-production</strong>, where this app lives. Editors
                  cut the scenes together, and <strong>VFX artists</strong> — illustrators
                  with powerful computers, working remotely for four small vendors
                  (HELIOSFORGE, PRISMWORKS, VANTASTUDIO, LUMENFRAME) — add everything the
                  camera didn&apos;t capture: the coffeehouse neon sign, wire removal from
                  a walk-and-talk shot, a stormy sky behind a rooftop monologue, crowd
                  tiling, the title sequence. Nobody is “recording episodes” anymore; they
                  are finishing pixels.
                </p>
              </section>
              <section>
                <h3>2. Who does what (the cast of this story)</h3>
                <ul>
                  <li>
                    <strong>Maya, post-production coordinator</strong> — owns the shot list,
                    the render queue, and the dailies checklist. She is the only person
                    connecting “the farm is slow” to “these exact shots won&apos;t make the
                    morning review.” Fifteen people, no night-shift engineer: she <em>is</em> the
                    night shift.
                  </li>
                  <li>
                    <strong>VFX artists (the vendors)</strong> — each owns their shots end to
                    end. Only they can requeue a failed render or fix a broken scene file.
                  </li>
                  <li>
                    <strong>VFX supervisor + director</strong> — judge the work at dailies
                    (“approved” / “redo this”). Their morning verdict sets the day&apos;s work.
                  </li>
                  <li>
                    <strong>Render wrangler</strong> — babysits the render farm (on a big show;
                    on PALS, Maya wears this hat too).
                  </li>
                </ul>
              </section>
              <section>
                <h3>3. Dailies: a meeting, not an episode</h3>
                <p>
                  <strong>Dailies</strong> is the review meeting held every morning at 9 AM,
                  where yesterday&apos;s finished VFX shots are projected on a screen and
                  approved or sent back. The name is a relic of the film era, when you
                  watched whatever was developed overnight — daily. A shot that isn&apos;t
                  rendered by 9 AM can&apos;t be shown: it is <strong>blocked</strong>, and
                  the delivery schedule slips a day. “Dailies at nine” is therefore a
                  deadline disguised as a meeting.
                </p>
              </section>
              <section>
                <h3>4. The render queue: the overnight factory</h3>
                <p>
                  A VFX shot isn&apos;t “saved” — it&apos;s <strong>computed</strong>. Every
                  frame takes minutes to hours on a <strong>render farm</strong> (a room of
                  servers), and all 240 shots&apos; jobs line up in a{" "}
                  <strong>render queue</strong>. The heavy renders run overnight: nobody is
                  watching, and morning is the deadline. A healthy job waits ~30 seconds
                  and completes. A sick one waits ~300 seconds, times out, and fails —
                  exactly what our demo data shows for HELIOSFORGE (
                  <code>examples/PALS-render-queue-sample.csv</code>).
                </p>
                <p>
                  <strong>“Silently stalled”</strong> means the queue looked busy while
                  actually choking — jobs timing out one after another — and{" "}
                  <strong>no alert fired</strong>. Nothing paged anyone. The failure sat
                  visible in the numbers for hours with nobody looking.
                </p>
              </section>
              <section>
                <h3>5. How Grafana learns about PALS (who sends what, who clicks what)</h3>
                <p>
                  Grafana doesn&apos;t know the show — it knows the{" "}
                  <strong>infrastructure</strong>, because every measurement carries a{" "}
                  <code>production=&quot;PALS&quot;</code> label, like a luggage tag. The
                  pipeline has four parts; only the last one is something a human clicks:
                </p>
                <ol>
                  <li>
                    <strong>Render nodes do the work</strong> and emit two kinds of exhaust:
                    numbers (how long each job queued, completed or failed) and text log
                    lines (<code>render failed: rq-pal-001 … queue timeout after 302.2s</code>).
                  </li>
                  <li>
                    <strong>Prometheus stores the numbers.</strong> It is a time-series
                    database — think of it as a giant spreadsheet that appends a row every
                    few seconds. <strong>Maya never opens Prometheus.</strong> Nobody
                    “queries Prometheus by hand” at 2 AM; it is plumbing.
                  </li>
                  <li>
                    <strong>Loki stores the log text</strong> (same idea, for log lines
                    instead of numbers; a small agent called Promtail forwards them).
                  </li>
                  <li>
                    <strong>Grafana is the window Maya looks through.</strong> It draws
                    dashboards (the latency graph, the failed-jobs table) by querying
                    Prometheus and Loki, and it owns alert rules that are supposed to fire
                    when latency crosses a threshold. The pre-built{" "}
                    <em>CineOps — PALS render queue</em> dashboard and its alert rule
                    (see <code>examples/PALS-grafana-setup.md</code> for the exact clicks
                    that built them) are what the demo annotates.
                  </li>
                </ol>
                <p>
                  And the final link: the <strong>Grafana Cloud MCP server</strong> is a
                  doorway that lets software — our agent — use Grafana the way Maya does:
                  81 tools for querying metrics, logs, traces, searching dashboards, and
                  managing alerts and incidents. The app&apos;s every Grafana read and
                  write goes through that doorway; each one is logged to{" "}
                  <code>logs/mcp-grafana.jsonl</code> and shown on an evidence card.
                </p>
              </section>
              <section>
                <h3>6. The pain: Maya&apos;s 2 AM, step by painful step</h3>
                <ol>
                  <li>
                    <strong>Discovery (30–60 min).</strong> Nobody alerted her, so Maya
                    finds out late — a vendor&apos;s worried message, or a dashboard that
                    “looks wrong.” She digs through Grafana panels by hand, reading
                    latencies and failed-job rows one screen at a time.
                  </li>
                  <li>
                    <strong>The manual join (1–2 hours).</strong> Grafana knows <em>which
                    jobs died</em>; it does not know <em>which dailies shots that
                    endangers</em>. That requires the shot list (statuses, due dates),
                    the delivery memos (HELIOSFORGE promised shots PAL-001…040 by
                    Saturday 5 PM — see{" "}
                    <code>examples/PALS-vfx-delivery-memo-alpha.md</code>), and shot
                    dependencies (PAL-009 can&apos;t finish before PAL-005). Maya holds
                    all three in her head and types shot IDs into a spreadsheet. This
                    join — telemetry + production intent — is skilled, slow, error-prone
                    work at the worst possible hour.
                  </li>
                  <li>
                    <strong>The 2 AM pings.</strong> Only each vendor&apos;s artist can fix
                    their shot: requeue the render, repair the scene file, confirm the
                    sign spelling. And artists care about dailies because dailies is where
                    their work is judged — an empty slot next to your name in the morning
                    review is how you lose the next contract. So Maya wakes people up on
                    Discord, one vendor at a time, with incomplete information.
                  </li>
                </ol>
                <p>
                  Total cost: <strong>hours per incident</strong> — spent building the
                  blocked list instead of fixing the blockage — plus slipped delivery
                  dates when the list arrives too late to act on.
                </p>
              </section>
              <section>
                <h3>7. How this app erases that night</h3>
                <p>
                  CineOps Guardian performs Maya&apos;s whole 2 AM workflow as one
                  supervised run. Watch for each manual chore disappearing:
                </p>
                <ul>
                  <li>
                    <strong>She asks in plain English</strong> (“which shots are blocked
                    for tomorrow&apos;s dailies and why?”) instead of translating her
                    worry into dashboard clicks.
                  </li>
                  <li>
                    <strong>Gemini plans Grafana queries</strong> from that question; the
                    agent executes them through the MCP server — the digging, automated,
                    with every tool call shown on an evidence card.
                  </li>
                  <li>
                    <strong>Deterministic rules do the join</strong> — telemetry × shot
                    list × delivery memos — in seconds, with citations. No spreadsheet, no
                    transcription errors. The model explains; pure Python decides.
                  </li>
                  <li>
                    <strong>Nothing writes itself — and be clear on what approval is.</strong>
                    Approving does <em>not</em> fix any render. No software can un-stall
                    a render farm; only an artist requeueing a job (or a farm operator
                    clearing the jam) does that. What Maya approves is the agent&apos;s
                    proposed <em>record</em>: a pinned note on the Grafana dashboard
                    (“PAL-118 blocked: queue stall, evidence…, 27 h at risk”) plus an
                    incident note, with deep links she can paste into Discord. The 2 AM
                    pings still happen — but at 12:30, targeted at only the affected
                    vendors, each message carrying exact shot IDs, causes, and proof,
                    instead of at 4 AM with guesses.
                  </li>
                  <li>
                    <strong>She leaves with a handoff, not just a diagnosis</strong>: cited
                    findings, a <em>recommended</em> new shot order (which shots should
                    jump the queue for dailies — Maya hands it to whoever can requeue,
                    the app doesn&apos;t touch the farm itself), an hours-saved total,
                    and a CSV for the color session. The morning brief, generated
                    before she finishes her coffee.
                  </li>
                </ul>
              </section>
              <section>
                <h3>8. Glossary (every jargon word in one place)</h3>
                <ul className="cg-guide-gloss">
                  <li><strong>Dailies</strong> — the 9 AM review meeting; also its deadline.</li>
                  <li><strong>Call sheet</strong> — the shoot day&apos;s plan (who/where/when).</li>
                  <li><strong>Delivery memo</strong> — a vendor&apos;s written turnover promise.</li>
                  <li><strong>Shot list</strong> — the 240-row master table of every VFX shot.</li>
                  <li><strong>Render farm / queue</strong> — servers that compute frames / the jobs waiting for them.</li>
                  <li><strong>Prometheus</strong> — database of numbers-over-time; plumbing, not a UI.</li>
                  <li><strong>Loki (+ Promtail)</strong> — database of log text; same, for logs.</li>
                  <li><strong>Grafana</strong> — dashboards + alerts on top of both; what Maya clicks.</li>
                  <li><strong>MCP server</strong> — the doorway letting the agent use Grafana&apos;s tools.</li>
                  <li><strong>Blocked (shot)</strong> — won&apos;t make dailies; the thing Maya hunts.</li>
                  <li><strong>Annotation</strong> — a pinned note on a Grafana graph (“PAL-118 blocked: queue stall”).</li>
                </ul>
              </section>
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
