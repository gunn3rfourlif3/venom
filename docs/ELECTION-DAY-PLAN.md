# The 14-day plan

**Election day is Wednesday 4 November 2026.** Today is 21 October 2026.
That is 14 days, one engineer, and a ground operation that has not yet
rehearsed its reporting loop.

This document exists because the Todo list describes roughly nine months of
work. Most of it is good work. Almost none of it can be done before
4 November, and attempting it is the one choice guaranteed to leave nothing
working on the day.

So this is the triage. Everything in `XNITH-SCOPE.md` is still going to be
built; this says what gets built *first* and what explicitly waits.

---

## The test every item is judged against

> On 4 November, between 07:00 and 21:00, does this change a decision
> somebody makes within the hour?

If no, it is post-election work. Not cancelled — post-election. The 2026
results and the 2026 ground data are themselves the material the forecasting
model, the national expansion and the provider platform need in order to be
any good. Building those *after* the election is not a delay; it is the only
order in which they can be built well.

---

## In scope before 4 November

Six items. Nothing else.

| # | Item | Why it survives the test | Est. |
|---|---|---|---|
| 1 | **Logistics layer finish** — HQ paste form, rollup tiles, mobile view | A blind station at 10:00 is a station you can still fix by 12:00 | 2.5 d |
| 2 | **National station + ward register** — all 23,699 stations, 4,488 wards | Without it the logistics layer only works in Gauteng | 1.5 d |
| 3 | **Mobile command view** | You asked for decisions while moving. On the day you will not be at a desk | 1.5 d |
| 4 | **Alerts** — blind, unstaffed, supply break, high-severity | The rollup is only useful if it reaches someone not looking at it | 1 d |
| 5 | **Deploy + harden + backups** on `xnith.zaaka.io` | A system that dies at 11:00 with no backup is worse than no system | 1 d |
| 6 | **Two live drills** with real marshals | An untested reporting loop fails on the day. Every time | 2 d |
| 7 | **Automated WhatsApp ingest** — webhook, roster allowlist, ack replies | Manual paste does not scale past Gauteng, and barely to it | 1.5 d |

**Total: 11 days of work in 14 calendar days.** The margin is deliberate and
it is not spare capacity — it is for the things that go wrong.

### Why item 7 was added, and what it changes

The manual plan died on arithmetic. One marshal per station reporting
two-hourly is ~24,000 messages across the day for Gauteng's 3,446 stations and
~166,000 nationally. One operator pasting batches of fifty needs roughly eight
hours of unbroken work to cover Gauteng, with no slack at all; national was out
by a factor of about seven.

So ingest is automated, and the consequence is good: **national scope on
4 November becomes feasible**, where with manual entry it was not.

Two things that are deliberate rather than incidental:

- **The paste form stays**, as the fallback. An automated pipeline with no
  manual path is still a single point of failure, just a better-looking one.
  When a webhook stops being delivered at 09:00, a human has to be able to get
  reports in.
- **Both paths share one parser.** `parseLine()` serves the webhook and the
  form, so what a drill teaches us about how marshals actually type is fixed in
  both at once, and they cannot drift.

**The roster is not optional.** A human pasting messages is incidentally a
filter — they can see that a report is nonsense. A webhook cannot. The moment
the reporting number is known, and thousands of marshals will know it, anyone
can send `10234 none none 0` and put a staffed booth onto the exception list.
So `reporter_roster` is an allowlist: a message from a number not on it is
recorded and refused, never filed. Loading that roster is part of standing
ingest up, not an afterthought.

### Deliberately NOT before 4 November

- **Brand revamp / 3 mockups / design standard.** Repainting the interface in
  the fortnight before the event it was built for risks breaking working
  screens for no operational gain. The design standard is the *first* thing
  after the election, and it will be better for having watched the current
  screens used under pressure. (If the brand assets arrive and you want one
  thing: a logo swap and the accent colour token. Half a day, no layout
  changes.)
- **Proprietary comms app.** See "Why WhatsApp stays" below.
- **Service-provider platform and driver tracking.** A new app, a new
  registration flow and background GPS, adopted by thousands of people, two
  weeks out. Not possible, and the failure mode is losing the reporting loop
  you already have.
- **National expansion of sentiment / results back to 2000.** Analytical, not
  operational. Nothing about it changes a decision on the day.
- **Forecasting model.** It has no 2026 ground truth to calibrate against
  until 4 November. Built before, it is a guess with a confidence interval
  drawn around it.
- **DevOps agent.** Automating deployment during the fortnight you can least
  afford a surprising deployment.
- **TikTok scraper.** Not buildable by any lawful route — see
  `DATA-SOURCES.md`. This one is not a timing decision.

---

## Why WhatsApp stays for 4 November

The addendum offers a choice between a manual-entry form and a WhatsApp
Business API webhook, and calls manual entry the MVP. That is correct, and
for a stronger reason than build time.

Marshals already have WhatsApp installed, already know how to use it, and
already have it open. Any proprietary tool must be installed, explained and
adopted by thousands of people who are volunteering, in a fortnight, with no
training window. The adoption risk is not the app's — it is the reporting
loop's. If 30% of marshals do not install it, you have not gained a secure
channel; you have lost a third of your visibility.

So: WhatsApp in, HQ paste form as the ingest, and the secure auditable
channel is built properly afterwards, for 2031 and for the by-elections in
between. The audit trail you need on the day is the one that already exists —
`booth_report` is append-only and every row carries who filed it and when.

---

## Day by day

Dates are working assumptions; the ordering is what matters, because each
item unblocks the next.

### Week 1 — make it work

**Tue 21 Oct · WhatsApp platform setup starts today (item 7)**
Calendar time, not work time, which is why it goes first: the code is written
and tested, but Meta's side has a timeline nobody controls.
- Check in Meta Business Manager whether a real number can receive inbound
  messages before business verification completes (`OPEN-QUESTIONS.md` Q15)
- Register the dedicated reporting number, set the webhook to
  `https://xnith.zaaka.io/api/whatsapp/webhook`, set the verify token
- Load the marshal roster via `POST /api/roster`
- Checkpoint: send a real message from a rostered phone and see it in
  `booth_report`; send one from an unrostered phone and see it refused in
  `v_ingest_exceptions`

**Tue 21 – Wed 22 Oct · National register (item 2)**
Load every ward and voting station nationally. This is first because items 1
and 3 are useless outside Gauteng without it, and because it is the item most
likely to surface a nasty surprise in the IEC's published formats — better to
find that on day one than on day ten.
- Pull the 2026 ward list (MDB handover, 4,488) and the voting station
  register (23,699) — see `DATA-SOURCES.md` for what is actually published
  and in what format
- Extend `ward` and `station` nationally; keep `demarcation_code` as the join
- Checkpoint: `SELECT count(*) FROM station` returns ~23,699, and every
  station resolves to a ward that resolves to a municipality

**Thu 23 – Sat 25 Oct · Logistics finish (item 1)**
Migration 025 is already applied; the API is written. What is missing is the
surface people use.
- HQ paste form: textarea → parse → review table → commit (the parse and
  commit endpoints exist)
- Four rollup tiles, driven by `v_logistics_rollup`
- Station table with the presence and supply flags, filterable
- Call sheet screen (role-gated; it is the one screen that shows a phone
  number)
- Checkpoint: paste 50 lines including three deliberately wrong booth
  numbers. The three are named back; the other 47 are written; nothing is
  silently dropped

**Sun 26 Oct · Mobile command view (item 3)**
- The rollup, the exception list and the call sheet at phone width
- Thumb-reachable, legible in direct sunlight, works on a bad connection
- Checkpoint: open it on your own phone, outside, on mobile data, and try to
  find the worst station in under ten seconds

### Week 2 — make it survive

**Mon 27 Oct · Alerts (item 4)**
- Thresholds read from `control_panel`, not hardcoded
- Blind station, unstaffed station, supply break, high-severity problem
- Delivery: push and email to the command-centre roles
- Rate-limited and deduplicated. An alert system that fires 400 times at
  07:05 because nobody has reported yet is an alert system people mute by
  07:10, and a muted alert system is worse than none
- Checkpoint: force each of the four conditions; confirm exactly one alert
  per condition per station per window

**Tue 28 Oct · Deploy and harden (item 5)**
Follow `DEPLOY-VPS.md` exactly.
- `xnith.zaaka.io`, isolated container stack, resource-limited so it cannot
  starve your other sites
- Nightly `pg_dump` off the box, and a **restore rehearsed once** — an
  unrestored backup is a hope
- Checkpoint: restore last night's dump into a scratch database and run the
  verification query

**Wed 29 Oct · Drill 1 (item 6)**
Ten real marshals, real phones, the real template, one hour.
- Measure: how many messages arrive in the right format, how long one HQ
  operator takes per batch, what the template gets wrong
- Expect the template to be wrong. People will send "no water at the
  station" where the format wants a head count. Find that now
- Fix whatever it surfaces on Thu 30

**Thu 30 Oct · Fix and freeze**
Fix drill findings. Then **feature freeze**: from this point, only bug fixes.

**Fri 31 Oct · Drill 2, full dress**
Fifty marshals across more than one municipality, two hours, two reporting
cycles. HQ operator working the real form on the real deployment. If drill 2
surfaces something structural, there is still a weekend.

**Sat 1 – Sun 2 Nov · Contingency**
Held empty on purpose. If nothing is broken, rest — you will need it on the
4th.

**Mon 3 Nov · Readiness**
- Special votes are being cast; the reporting loop gets a real rehearsal with
  real stakes
- Verify backups, verify alerts reach phones, verify the HQ operator's
  machine and a second machine that can take over
- Print the fallback: if the system is down, marshals still send WhatsApp
  messages and someone writes them on paper. Decide who, now

**Tue 4 Nov · Election day**
Nobody deploys anything. One person watches the system, a different person
operates the form. The engineer stays free to fix, not to ship.

---

## What could still go wrong

Honest list, with what reduces each.

| Risk | Reduction |
|---|---|
| IEC station register is not published in a usable form | Day 1 is reserved for exactly this. Fallback: load Gauteng properly and accept provincial scope on the day |
| One HQ operator cannot keep up with national volume | The paste form takes batches, not single reports. Measure throughput in drill 1 and add operators, not features |
| Marshals do not follow the template | Drill 1 is scheduled to find this while there is still time to simplify |
| VPS falls over under election-day load | Load is tens of HQ operators, not thousands of marshals — see `ARCHITECTURE.md`. The 6-core box is not the constraint |
| The engineer is the single point of failure | Write the runbook as you go, not after. `DEPLOY-VPS.md` must be followable by someone who is not you |

---

## After 4 November

The election is the start of the real build, not the end of it. In order:

1. Post-mortem while it is fresh — what the ground actually needed
2. Design standard and brand revamp, applied once, properly
3. National results back to 2000, with delimitation vintage keys
4. Secure comms platform, for the by-elections
5. Service-provider platform and resource allocation
6. Forecasting, calibrated against 2026 ground truth

`BUILD-PLAN.md` carries that sequence in full.
