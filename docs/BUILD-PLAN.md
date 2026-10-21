# Build plan

Ordered phases with their dependencies. The next fortnight is in
`ELECTION-DAY-PLAN.md` and takes precedence over everything here; this document
picks up on 5 November.

The ordering rule throughout: **a phase may only depend on phases above it.**
Where two phases are independent they are marked parallel, because with one
engineer the only real parallelism is "this can wait without blocking that".

---

## Phase 0 · Election readiness — now to 4 Nov 2026
`ELECTION-DAY-PLAN.md`. Six items, 9.5 days of work, 14 calendar days.
Everything else in this document waits.

**Exit:** the election is run, and the logistics layer carried real traffic.

---

## Phase 1 · Post-mortem and foundation — 5–15 Nov
Deliberately first, and deliberately before any new feature.

| Task | Depends on | Why now |
|---|---|---|
| Election-day post-mortem | Phase 0 | Written within 72 hours, while people still remember what they needed and could not get. This document is the requirements input for Phases 4–6 |
| Load the 2026 results, all levels | — | The IEC publishes them within days. This is the ground truth the forecasting model needs, and it is also the first real test of the results loader |
| `GOTCHAS.md` sweep | Phase 0 | Every incident from the day, written down while it is fresh |
| CI: typecheck, migrate dry-run, smoke test | — | Should have existed already. Cheap, and it ends the "worked on my machine" class of problem |
| Rename repository to `xnith` | — | Freeze is over, so now it is safe (`GOTCHAS.md` G1) |

**Exit:** 2026 results loaded and queryable; CI green on every push.

---

## Phase 2 · Design standard — 16 Nov–5 Dec
Blocked on your brand assets (`OPEN-QUESTIONS.md` Q12). Runs **parallel** to
Phase 3, since one is design and the other is data.

| Task | Depends on |
|---|---|
| Palette and type as design tokens, from the real brand assets | Q12 |
| Three mockups: command view, ward dossier, logistics board | tokens |
| Pick one, write the standard — spacing, states, chart rules, per-layer accent | mockups |
| Apply across existing screens, once | standard |
| Accessibility pass: computed contrast, both themes, phone width | applied |

**Why it is one phase and not an ongoing effort:** applying a design standard
incrementally means living with two visual languages for months. Do it once,
in one window, with the whole surface in view.

**Note on the references in the Todo.** The two Dribbble shots and the Gemini
link describe a direction — slick, militant, dense command-centre — and that is
what gets built: an original design standard in that spirit, with your brand's
real colours. Not a reproduction of those specific layouts.

---

## Phase 3 · National core — 16 Nov–20 Dec
Parallel to Phase 2.

| Task | Depends on | Notes |
|---|---|---|
| Municipal results 2000–2021, all five levels | Phase 1 loader | PDF/Excel pipeline; keep originals so a parse bug is re-runnable |
| Delimitation vintage keys + boundary archive | results | `GOTCHAS.md` G2. The thing that makes any cross-year claim valid |
| Boundary crosswalk, vintage to vintage | vintages | Areal interpolation by voter count, uncertainty carried forward |
| Stats SA ward demographics | — | **Highest-value single addition in the project.** Turns counts into rates and is the main missing forecasting input |
| Ward size vs norm heatmap | national wards | ±15% band, diverging scale. Answers the Todo's ward-size question directly |
| National press expansion (~100+ titles) | — | Same adapter, more rows |
| Multilingual scoring | — | Real accuracy gap: non-English wards are under-measured today |

**Exit:** any ward in the country, five municipal cycles deep, with
demographics, and no cross-vintage comparison possible without a crosswalk.

---

## Phase 4 · Comms — Jan–Feb 2027
Depends on Phase 1 post-mortem (it tells you what the ground actually needed).

| Task | Depends on | Notes |
|---|---|---|
| WhatsApp Business API ingest | — | **Do this first and alone if time is short.** Removes the HQ paste bottleneck entirely, with no adoption cost — marshals keep using WhatsApp |
| Append-only message log | ingest | Schema settled before there is history to migrate |
| Directed messaging HQ → ground | log, `commander` role | Command-centre roles only |
| Acknowledgement tracking | messaging | Sent / read / acted-on as three states |
| Access and retention policy | — | `OPEN-QUESTIONS.md` Q7. Settle before the channel exists |

**Exit:** ground reports reach the database without a human retyping them.

---

## Phase 5 · Resources — Mar–Jul 2027
The largest piece of work in the project. Depends on Phase 4 (a provider app
without a comms channel is a form) and on Q6 being settled.

| Stage | Task | Depends on |
|---|---|---|
| 5a | Provider registration and service catalogue | — |
| 5b | Assignment lifecycle: offered → accepted → en route → on site → complete | 5a |
| 5c | PWA for marshals and most providers | 5b |
| 5d | Allocation model — demand vs supply, **proposals a human approves** | 5b, Phase 3 targets |
| 5e | Allocation dashboard | 5d |
| 5f | Payment export: verified work → instruction file | 5b |
| 5g | Native driver app, store-distributed | 5c, Q6, Q8 |
| 5h | Routing with a commercial maps API | 5g, Q9 |
| 5i | Taxi routes as a dated context layer, where data exists | — |

**Gates, not preferences:**
- **5g does not start until Q6 is answered.** Driver location is the sharpest
  POPIA edge in the project and is nearly impossible to retrofit correctly
- **5d proposes, never commands.** A human allocates people. An allocation
  model that moves people automatically is both a safety problem and a trust
  problem
- **5i is context, not routing input.** Taxi route data is informal and stale;
  routing on it would be confidently wrong (`DATA-SOURCES.md` §5)

**Exit:** a provider can register, be assigned work, be tracked while on it,
and be paid from a verified record.

---

## Phase 6 · Forecasting — Aug–Oct 2027
Depends on Phase 3 (vintage-corrected history plus demographics) and Phase 0
(2026 ground truth).

| Task | Depends on |
|---|---|
| Turnout model per ward | Phase 3 |
| Support estimate, each input with its own confidence | turnout |
| **Calibration harness** — backtest 2006/2011/2016/2021, report error | both |
| Scenario tooling | calibrated model |

**The calibration harness is not optional polish.** A forecast without a
measured error band is an assertion with decoration. Build the harness
alongside the model, and if the backtest is poor, publish that rather than
tuning until the number looks good.

---

## Phase 7 · Platform maturity — continuous from Phase 1
Ongoing, not a window.

| Task | When | Notes |
|---|---|---|
| Move Postgres to managed (Tier 1) | Before Phase 5c ships | The database is the part you cannot rebuild from git. Move it first |
| Observability: four numbers, external synthetic check | Phase 1 | Minimal version in Phase 0 |
| DevOps agent | After Phase 4 | Configured with a runbook and memory, not trained. `GOTCHAS.md` is its memory and starts accumulating now |
| Alerting maturity — let the data set thresholds | Phase 3 | Once there is enough history for a baseline, thresholds should be derived rather than guessed |
| Tier 2 scale-out | Month before the next election | Not before. Peak load is one day a year (`ARCHITECTURE.md` §3) |

---

## Commit cadence

Per your standing instruction, commands come with every change. The intervals
that make sense:

| When | Why |
|---|---|
| Every migration, on its own | A migration is the one change that cannot be rolled back. It should be bisectable alone |
| Every completed screen | Reviewable as a unit, revertable as a unit |
| Every source adapter | Self-contained; one adapter breaking should not force reverting another |
| Before and after each deploy | So there is a known-good commit to roll back to, named in the deploy log |
| End of every working day during Phase 0 | Fourteen days with one engineer. An uncommitted day is a day that can be lost |

Tag each phase exit (`git tag phase-1-complete`) so the post-mortem has
boundaries to diff against.
