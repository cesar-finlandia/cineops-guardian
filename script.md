# CineOps Guardian — 3-Minute Trailer Script (read-aloud)

> **How to use:** rehearse with a timer. The **Read** column is the exact
> voiceover — ~400 words total, ≈145 wpm, fits 3:00 with breathing room.
> The **Show** column is the exact screen/slide cue. Only the first 3 minutes
> are judged — hard cut at 3:00.
>
> **What is PALS?** PALS is our fictional demo production: a no-budget indie
> ensemble comedy in the spirit of FRIENDS, made by 15 people. It is not a real
> series — every shot, memo, and metric is synthetic demo data watermarked
> `synthetic:true`. (It was renamed from NEON HOLLOW so any viewer instantly
> gets the joke: six friends, one couch, zero budget.) Say the one-liner in
> Slide 1 and move on.

## Timing budget

| Block | Time | Words | Purpose |
|---|---|---|---|
| Greeting + what-this-video-is | 0:00–0:12 | ~27 | hello, app name, hackathon relevance |
| Problem, Slide 1 (pain without the app) | 0:12–0:37 | ~62 | the 2 a.m. coordinator reality |
| Problem, Slide 2 (how the app works) | 0:37–1:00 | ~66 | pipeline + payoff, app screenshots |
| Live demo (the diagnosis, on camera) | 1:00–2:52 | ~260 | ingest → stream → approve → results |
| Closing card | 2:52–3:00 | ~15 | track statement, cut hard at 3:00 |

## The script

| Time | Read (voiceover, verbatim) | Show (screen) |
|---|---|---|
| 0:00–0:12 | "Greetings from Helsinki! I will talk about CineOps Guardian, my Grafana Labs entry: a Gemini-powered agent that answers a post-production emergency with live Grafana data — and writes its findings back."  Btw you can find all details that explain this Postproduction callflow by clicking ‘How dailies work’ button it will explain the World this application lives in. I want to highlight that the usecase this app solves is not a made up one, it is a real usecase that I have personally researched in the corresponding Reddit channels, this App solves a real and current workflow painpoint experienced by low budget productions.    | Title card: app name + "Grafana Labs track · Gemini 2.5 Flash on Vertex AI · google-adk · Grafana Cloud MCP · Cloud Run". Your face or voice over it, 3 seconds max, then cut. |
| 0:12–0:37 | "Meet Maya. She coordinates PALS — a no-budget indie comedy in the spirit of FRIENDS, fifteen people, dailies at 9am. Last night the render queue silently stalled. No alert, no explanation. So Maya did what coordinators always do: dug through Grafana panels by hand, copy-pasted shot IDs into a spreadsheet, and woke her vendors on Discord at two a.m. Hours gone — and dailies still at risk." | **Slide 1.** Left: infographic Asset A (the manual triage chain). Right: photo Asset B (exhausted Maya, 2 a.m. desk). One line under it: "Hours per incident. Slipped dates." |
| 0:37–1:00 | "CineOps Guardian ends that night. Maya just asks: which shots are blocked for tomorrow's dailies, and why? Gemini — Google's AI — turns her question into Grafana queries. The agent runs them through the MCP server, Grafana's doorway for software, and matches the results against her delivery memos in seconds — the join that used to take her two hours. Cited facts, a recommended new shot order, hours saved. Same Maya, rested." | **Slide 2.** Top: infographic Asset C (the pipeline). Bottom-left: photo Asset D (rested Maya, sunlit office). Bottom-right: 2 app screenshots — S2 run screen with evidence cards, S4 result totals. |
| 1:00–1:18 | "Live, on Cloud Run — no slides from here. This is the Dailies Console. Production PALS, tomorrow's dailies window, severity medium. Demo data is loaded. Diagnose." | Browser: address bar visible, app loads. Ingest screen, defaults untouched. Name the 'How dailies work' button without clicking it. Click **Load demo production** (green ready widget appears), then **Diagnose**. |
| 1:18–1:50 | "Eight steps stream live. Watch the evidence rail: every card names the MCP tool that produced it — query_prometheus for queue latency, query_loki_logs for failed jobs, search_dashboards for the pipeline view. That is the track gate, on camera: real Grafana Cloud calls, row counts, milliseconds." | Run screen. Let steps 1–3 play. Zoom or pause briefly on 2–3 evidence cards so tool names and row counts are legible. |
| 1:50–2:05 | "Health, in one frame: Gemini reachable on Vertex, eighty-one MCP tools live, BigQuery connected, spend near zero of budget — plus the Cloud Run logs tail proving where this runs." | Quick flash: `/api/health` JSON (or the header pill hover) + terminal tail of Cloud Run logs. 15 seconds, keep moving. |
| 2:05–2:32 | "The agent now pauses and asks Maya — because writing to a shared dashboard should be her decision, not the AI's. It has drafted two notes: one pinned to her Grafana panel naming the blocked shots and why, one incident note she can forward to her vendors. She ticks the boxes and clicks Approve selected. The renders themselves haven't changed — but her dashboard now states the problem in plain language, so there's no more 4 a.m. guessing." | Approval slate → click **Approve selected**. Cut to Grafana: dashboard panel before/after annotation + incident note. Hold the after-shot 3 seconds. |
| 2:32–2:52 | "Back in the console: every finding cites its evidence and memo, the shot order shows what to requeue first — hours saved on both ends, her diagnosis and the vendors', because they get exact shots and causes, not a midnight mystery. One click exports the CSV for the color session." | Result screen: totals strip, one finding card with citations, **Hours saved**, revised table, click **Download revised schedule CSV**. |
| 2:52–3:00 | "Rules check the facts, AI explains them. CineOps Guardian — built for the Grafana Labs track. Thank you!" | Closing card: app name, track, repo + URL. **Cut at 3:00.** |

## Graphical assets — exact generation prompts

Copy each block verbatim into your image tool (Gemini/Imagen). All landscape 16:9 (1920×1080). Keep on screen 8–12 seconds each.

### Asset A — infographic: the manual triage chain (Slide 1, left)

```text
Flat-vector infographic, 16:9, dark cutting-room background (#0B0B10), amber (#FFB224)
and muted red accents, clean sans-serif labels, no photorealism, no logos, no trademarks.
Title at top: "DAILIES AT RISK — THE MANUAL WAY".
Five left-to-right panels with icons and one-line labels:
1. moon icon — "Render queue stalls silently, 11:42 PM";
2. magnifier over dashboard grid — "Coordinator digs through Grafana panels by hand";
3. spreadsheet icon — "Shot IDs copy-pasted into a spreadsheet";
4. chat bubbles with "2:07 AM" — "Artists pinged on Discord at 2 a.m.";
5. slipped calendar with red flag — "Hours lost, dailies still blocked".
Footer strip: "Hours per incident · Slipped delivery dates".
High contrast, generous whitespace, legible at video resolution.
```

### Asset B — photo: exhausted Maya (Slide 1, right)

```text
Photorealistic cinematic still, 16:9. A tired woman in her early thirties,
post-production coordinator, at a cramped home desk at 2 a.m.: three monitors
glowing with dense operations dashboards, timeline spreadsheets, and a chat app;
cold coffee cup, sticky notes, dark room lit only by the screens, faint under-eye
shadows, hand on forehead. Shallow depth of field, muted teal-and-amber grade,
quiet despair, no text, no logos, no trademarks, no recognizable shows.
```

### Asset C — infographic: how the app works (Slide 2, top)

```text
Flat-vector pipeline infographic, 16:9, same dark cutting-room style and palette
as its companion (amber primary, teal for live-data steps), clean sans-serif labels.
Title: "CINEOPS GUARDIAN — ASK, PROVE, FIX".
Six left-to-right stages with icons:
1. speech bubble — "Plain-English question";
2. spark icon — "Gemini 2.5 Flash plans Grafana queries";
3. pulse/telemetry icon in teal — "Agent queries Metrics, Logs, Dashboards via MCP";
4. link icon — "Deterministic rules join telemetry to call sheets";
5. hand pressing a check button in amber — "Coordinator approves — nothing writes itself";
6. dashboard with annotation pin + clock — "Annotation written back · revised schedule · hours saved".
Footer strip: "Cited findings · One-click approval · Hours saved".
```

### Asset D — photo: relieved Maya (Slide 2, bottom-left)

```text
Photorealistic cinematic still, 16:9, same woman as the night shot, next morning
in a bright small production office: sunlight through blinds, smiling softly at a
laptop showing a tidy dailies checklist, paper call sheet and coffee beside her,
a couch with colorful cushions blurred in the background hinting a sitcom set.
Warm grade, calm and in control, visual rhyme with the 2 a.m. desk photo
(same person, same laptop sticker). No text, no logos, no trademarks.
```

## Screenshot shopping list (for Slide 2 + backup cuts)

Capture at 1920×1080, UI in dark Noir theme, production PALS:

| ID | Shot | Why |
|---|---|---|
| S1 | Ingest hero + defaults + green "Demo data ready" widget | proves one-click start |
| S2 | Run screen mid-stream: 8-step timeline + 3 evidence cards with MCP tool names legible | the track gate, static backup if live stream stutters |
| S3 | Approval slate with boxes checked | the "changes state" moment |
| S4 | Result totals (Blocked / High / Writes applied) + Hours saved + one finding with citations | the payoff |
| S5 | Grafana dashboard panel with the written annotation + incident note | before/after proof |

Slide 2 fits S2 + S4 only — small, bottom-right. Keep S1/S3/S5 as cutaways during the demo if the live run lags.

## Recording checklist

1. Pre-seed the demo, run one full pass privately, leave the browser on Ingest.
2. Record narration and screen separately if possible; 400 words ≈ 2:45 at 145 wpm.
3. The three NEVER-CUT beats: evidence cards with tool names (1:18–1:50), approval click + Grafana after-shot (2:05–2:32), hours saved + CSV (2:32–2:52).
4. If over time, cut in this order: health flash → closing card tail → one evidence-card pause. Never cut the approval click.
5. Upload public, English, no third-party logos visible (Asset prompts already exclude trademarks).
