# Xnith — scope and module breakdown

Everything in the Todo, decomposed into layers that can be built, deployed and
reasoned about separately while sharing one data spine.

**Naming.** The product is now **Xnith**. The git repository stays `venom` for
now — see `GOTCHAS.md` G1 for why renaming it mid-build is a bad trade and how
to do it safely later.

**Timing.** Everything here is marked `[NOV]` (before 4 November 2026) or
`[POST]`. Only six items are `[NOV]`; `ELECTION-DAY-PLAN.md` explains that
triage and is the document to follow for the next fortnight.

---

## The layer model

Eight layers. Each owns its own tables, exposes views, and reads other layers
only through those views — never by reaching into another layer's tables. That
rule is what makes any one of them liftable into its own service later without
a rewrite, and it costs nothing to follow now.

```
L7  Platform & DevOps ....... deploy, observability, alerting, agents
L6  Forecasting ............. turnout & support models, scenario tooling
L5  Command Centre .......... mobile-first dashboard, alerts, map
L4  Resources ............... provider platform, allocation, routing
L3  Comms .................... secure auditable channel, ground ↔ HQ
L2  Logistics ............... supply, presence, incidents    ← mostly built
L1  Intelligence ............ sentiment, press, service delivery  ← built
L0  Core ..................... geography, results, wards, extract ← built
```

Shared spine: `demarcation_code` → `ward_id` → `station_id`. Every layer keys
to it. Nothing invents its own geography.

Shared theme: one design system, per-layer accent so a screenshot is
identifiable at a glance without looking like a different product.

---

## L0 · Core — geography, results, the extract

**State:** built for Gauteng (523 wards). Needs national expansion.

| Item | When | Notes |
|---|---|---|
| National ward + station register (4,488 wards, 23,699 stations) | `[NOV]` | Blocks L2 outside Gauteng. First task |
| VD-level drill-down | `[POST]` | VD and ward are the same 4,488 units for 2026 — see `DATA-SOURCES.md` §4 |
| Results back to 2000 with delimitation vintage keys | `[POST]` | Not 1994. See §"The 1994 problem" below |
| Ward size vs norm heatmap | `[POST]` | ±15% band. Legally grounded and genuinely useful — see below |

**Stack:** PostgreSQL 16, SQL migrations, Node/TS loaders. Unchanged.

### The 1994 problem

The Todo asks for election data back to 1994. At ward or VD level **this data
does not exist and cannot be reconstructed.** Not "is hard to find" —  does not
exist:

- **1994 had no voters' roll at all.** The Electoral Act made no provision for
  one; eligibility was checked against an identity document on the day, with
  indelible ink to prevent double voting
- Votes were counted at **70 central counting stations**, not where they were
  cast. The procedure for tracing each ballot box back to its polling station
  broke down, and the decision was taken to count the boxes regardless
- There were **no municipal wards** in the present sense. The current
  municipal system and its demarcation date from 2000

What is actually available:
- **Municipal results: 2000, 2006, 2011, 2016, 2021** from the IEC results
  portal, at province / municipality / ward / ballot / voting-district level,
  as PDF and Excel
- **National & provincial: 1999 onward** as PDF reports

So the honest target is **municipal back to 2000** and **national back to
1999**, with 1994–96 treated as narrative context rather than data. That is
five municipal cycles — ample for trend work.

### The delimitation trap

Ward boundaries are redrawn before every municipal election: 2000, 2006, 2011,
2016, 2021, and again for 2026. **Ward 42 in 2016 is not Ward 42 in 2021.**
Comparing a ward's 2016 result to its 2021 result without accounting for this
produces a number that looks like a trend and is an artefact.

The schema must therefore store every result against a **delimitation
vintage**, and refuse to compare across vintages unless an explicit
areal-interpolation crosswalk is applied (overlaying boundary sets and
apportioning by voter counts, with the resulting uncertainty carried forward).
Tracked in `GOTCHAS.md` G2 — it is the single most likely source of a
confidently wrong figure in the whole system.

### Ward size — the answer to "what is the maximum?"

There is no single national maximum. The rule is **relative to each
municipality**:

- The **norm** = that municipality's registered voters ÷ its number of wards
- No ward may deviate from its own municipality's norm by more than **15%**

So a metro ward's legal ceiling is far higher than a rural ward's. For 2026:
**4,488 wards, 27.7 million registered voters at handover** (about 29 million
by August 2026) — a national average near 6,200 per ward, but Johannesburg
wards run several times that.

The MDB proposed raising the tolerance from 15% to 30% and it was before
Cabinet in 2020; whether 15% or 30% applies to the 2026 delimitation is
`OPEN-QUESTIONS.md` Q3. The schema should hold the tolerance as a
`control_panel` value, not a literal.

**The heatmap you asked for** is therefore: each ward's registered voters as a
**percentage deviation from its own municipality's norm**, on a diverging scale
centred at zero with the ±15% band marked. Wards outside the band are either
delimitation anomalies or genuine growth pressure, and both are worth knowing
about. This also answers the operational point in the Todo directly — the
tolerance bounds the maximum result-slip volume and sentiment volume per ward,
which is what makes pagination and batch sizes predictable.

---

## L1 · Intelligence — sentiment, press, service delivery

**State:** built. Local press (22 Gauteng titles, open RSS), news, Instagram
(aggregate-only), municipal finance from municipalmoney.gov.za, synthetic
baseline clearly stamped as such.

| Item | When | Notes |
|---|---|---|
| Daily cadence for the sweeps | `[NOV]` | Small. Already specced — see `DEPLOY-VPS.md` §7 |
| National press expansion (~100+ titles) | `[POST]` | Same adapter, more rows in `press_title` |
| Stats SA / DataFirst service-delivery facts | `[POST]` | Adapter pattern already proven |
| Multilingual scoring | `[POST]` | The lexicon is English; isiZulu, Sesotho, Afrikaans wards are under-measured today. A real accuracy gap |
| TikTok comment scraper | **Not buildable** | See `DATA-SOURCES.md` §6 |

**Stack:** Node/TS adapters, no runtime dependency beyond `pg`. Scoring is a
local lexicon with an optional transformer model behind the same `Scorer`
interface.

**The boundary that does not move:** text is scored in memory and only counts
reach disk. No names, no contact details, no attributed quotes, no identity
numbers — enforced by CHECK constraints, not by convention.

---

## L2 · Logistics — supply, presence, incidents

**State:** migration 025 applied; API written; **UI outstanding.** This is the
highest-value layer for 4 November.

| Item | When | Notes |
|---|---|---|
| HQ paste form (batch parse → review → commit) | `[NOV]` | Endpoints exist. Needs the screen |
| Four rollup tiles | `[NOV]` | `v_logistics_rollup` |
| Station exception table | `[NOV]` | Sorted worst-first |
| Call sheet (role-gated) | `[NOV]` | Only screen serving a phone number |
| Map layer coloured by presence | `[POST]` | The table is the operational tool; the map is the briefing tool |
| Result-slip capture | **Candidate** | If the above lands early. See below |
| WhatsApp Business Platform webhook | `[NOV]` | **Promoted.** Manual paste does not scale past Gauteng; see `ELECTION-DAY-PLAN.md` item 7 |

**Four corrections made to the addendum spec** (all in migration 025):
1. `station_id` is `text`, not `integer` — the IEC uses codes, so the spec's
   foreign key would not have been creatable
2. Deployments are made to a **ward**, not a station, so the supply columns
   are named `ward_supply_*`. As written, one failed drop would have flagged
   every station in that ward as `SUPPLY_BROKEN`
3. `expected_people` may be NULL, which made the spec's whole presence `CASE`
   NULL and fell through to `STAFFED` — a station with two people and no
   staffing plan read as fully staffed. Now `NO_PLAN`
4. "Never update, never delete" is now a trigger rather than a comment, with
   one narrow exception for retention clearing an expired phone number

**Result-slip capture** is the "redemption line" from the addendum and is
small: photo + the numbers per station, time-stamped, append-only, compared
against pledges secured. It is the one `[POST]` item worth promoting into
`[NOV]` if week one finishes early, because it is the only chance to capture
that data — it does not exist after the night.

**Stack:** Postgres views (no materialisation; the live layer is small and
fast), Node/TS routes, server-rendered screens with progressive enhancement.

---

## L3 · Comms — secure, auditable, ground ↔ HQ

**State:** not started. `[POST]`, deliberately.

WhatsApp stays for 4 November, for adoption reasons set out in
`ELECTION-DAY-PLAN.md`. This layer is for the by-elections and 2031.

**Built early, out of necessity.** The WhatsApp ingest was scoped here as
post-election work and has been promoted into the fortnight — the manual-paste
arithmetic did not survive contact with 23,699 stations. What remains in this
layer is everything beyond ingest.

| Item | Notes |
|---|---|
| ~~WhatsApp ingest~~ | **Done** — `src/api/whatsapp.ts`, migration 026. Roster allowlist, HMAC verification, replay-safe, acknowledges each report |
| Directed messaging HQ → ground | Only command-centre roles may send. Every message logged append-only |
| Acknowledgement tracking | "Sent" is not "read" is not "acted on". Three distinct states |
| Proprietary app channel | Only once the provider app (L4) exists and has adoption. Building a channel before there are users is building a channel for nobody |

**Stack:** WhatsApp Business Cloud API (Meta) for ingest; in-app channel over
the existing SSE path with a push fallback. End-to-end encryption is **not**
promised — the requirement is *auditable*, and auditable and end-to-end
encrypted are in tension. Transport encryption plus an append-only server-side
log is the honest design, and it is what an audit actually needs.

**Open question Q7:** who may read the message log, and for how long is it
kept. A complete record of what HQ told the ground is exactly the record a
commission of inquiry would subpoena. That is an argument for keeping it
*clean*, not for not keeping it.

---

## L4 · Resources — provider platform, allocation, routing

**State:** not started. `[POST]`. The largest single piece of work in the
project.

| Item | Notes |
|---|---|
| Provider registration | Identity, services offered, availability, banking details for payment export |
| Service tracking | Assignment → accept → en route → on site → complete, each timestamped |
| Resource allocation model | Demand (ward target class, station presence gaps) → supply (available providers, travel time) → assignment proposals. **Proposals, not commands** — a human allocates |
| Allocation dashboard | Where the gaps are, who can fill them, what it costs |
| Driver tracking + routing | See `ARCHITECTURE.md` §5. The sharpest POPIA edge in the project |
| Taxi-route overlay | **Source does not exist nationally** — see `DATA-SOURCES.md` §5 |
| Payment export | Verified work → payment instruction file for the party's banking/payroll. **No money moves through Xnith** (your decision, and the right one) |

**Distribution — a real constraint worth knowing now.** The Todo says
providers download the app from the MKP website. Two problems:

1. **Sideloading an APK from a website** means asking every user to disable a
   security protection, and it trains a political movement's supporters to
   install unsigned software from a link — which is precisely the behaviour a
   hostile actor would exploit with a lookalike site. Strongly advise against
2. **Background location is not possible in a web app.** A PWA cannot track a
   driver with the screen off. That is a hard platform limitation, not a
   framework choice

The split that follows from those two facts:

| Who | What they get | Why |
|---|---|---|
| Marshals, reporters, most volunteers | **PWA**, installable from the site | No store review, instant updates, nothing to sideload. Foreground reporting is all they need |
| **Drivers only** | Native app, **via Play Store / App Store** | Background location requires it. Store distribution is also the only safe distribution |

Build the PWA first; it covers the large majority of providers. The native
driver app is its own project with its own review timeline — and note that app
store review of a political party's app has its own policy surface, which is
`OPEN-QUESTIONS.md` Q8.

**Stack:** PWA in the same Node/TS app (one codebase, no SPA framework needed);
native driver app in React Native or Flutter when it comes; routing via a
commercial maps API (`OPEN-QUESTIONS.md` Q9 — this is a real recurring cost at
national scale).

---

## L5 · Command Centre — mobile-first dashboard, alerts, map

**State:** desktop dashboard exists (rail-and-stage shell, overview, sentiment,
wards, control panel). Mobile view and alerts outstanding.

| Item | When | Notes |
|---|---|---|
| Mobile command view | `[NOV]` | Rollup, exceptions, call sheet at phone width |
| Alerts | `[NOV]` | Thresholds from `control_panel`. Deduplicated and rate-limited |
| Privilege model for resource movement | `[POST]` | Roles exist (`viewer`/`reporter`/`treasurer`/`admin`); a `commander` role is needed for L4 actions |
| Unified map | `[POST]` | Wards, stations, presence, resources on one canvas |
| Design standard + brand revamp | `[POST]` | Three mockups, tokens, applied once. Needs your brand assets |

**Stack:** server-rendered HTML with progressive enhancement; SSE for live
updates; hand-built SVG charts (no charting dependency — the existing charts
are already built this way and are the better for it).

**Interface principle, since the Todo asks for self-explanatory:** every screen
answers *what is wrong*, *where*, and *what to do about it*, in that order, and
every figure carries the timestamp it was true at. The 2×2 "what to do" matrix
on the wards screen already works this way; the logistics screens follow it.

---

## L6 · Forecasting

**State:** not started. `[POST]`, and genuinely better for waiting.

| Item | Notes |
|---|---|
| Turnout model per ward | Registered × historical turnout × registration change, by vintage-corrected ward |
| Support estimate | Pledges + historical result + sentiment, each with its own confidence |
| Scenario tooling | "If turnout in these 40 wards drops 5%, what happens" |
| Calibration harness | Backtest against 2006/2011/2016/2021, report error honestly |

**Why after the election.** A forecasting model needs ground truth to
calibrate against. Before 4 November there is none for this cycle, so anything
built now is an untested guess wearing a confidence interval. On 5 November
there will be 23,699 stations' worth of actual results to test against — and a
model calibrated on that is worth having for the 2031 cycle and every
by-election between.

**It must report its own error.** A forecast without a stated and *measured*
error band is not a forecast, it is an assertion. The calibration harness is
not optional polish; it is the thing that makes the model usable.

**Stack:** Python (statsmodels / scikit-learn) in a separate job container,
writing results back to Postgres as a layer the dashboard reads like any
other. Kept out of the Node app deliberately — different language, different
release cadence, no shared runtime risk.

---

## L7 · Platform & DevOps

| Item | When | Notes |
|---|---|---|
| Deploy to `xnith.zaaka.io`, isolated | `[NOV]` | `DEPLOY-VPS.md` |
| Backups + **rehearsed restore** | `[NOV]` | Highest-value hour in the project |
| Observability | `[NOV]` (minimal) | Four numbers, one external synthetic check |
| CI (typecheck, migrate dry-run, smoke test) | `[POST]` | Soon after the election |
| DevOps agent | `[POST]` | See below |

**On the DevOps agent.** Worth building, with one correction: it is not
*trained*, it is *configured and given memory*. There is no model fine-tuning
here — it is an agent with a runbook, access to the deploy path, and a written
record of what has broken before and what fixed it. That record is the whole
value, and it starts accumulating the moment you begin keeping it, which is
why `GOTCHAS.md` exists now rather than later.

Deliberately **not** before 4 November: introducing automated deployment in
the fortnight when an unexpected deployment is least survivable.

---

## Productivity tooling

Asked for in the Todo. Highest value per hour, in order:

1. **`npm run daily`** — one command for the whole sweep, so the scheduled task
   is one line and the log is one place. Built
2. **Rehearsed restore** — turns the backup from hope into a procedure
3. **`GOTCHAS.md`** — the memory the DevOps agent will later read. Costs a line
   per incident
4. **A staging deploy identical to production** — same compose file, different
   env. Prevents the entire class of "worked on my machine"
5. **`migrate --dry-run`** before every deploy. Already supported
6. **Drills before the election** — not tooling, but the highest-value hours in
   the next fortnight by a wide margin
