# What switching Xnith on fully costs

**Prepared 23 October 2026 · 12 days to polling day · 6 days to the first drill**

Every station and slip figure here is counted from the register, not estimated.
Every **rand figure is an estimate and is marked as one** — I have not priced
anything against a live rate card or a supplier quote, and the stipend rates in
particular are assumptions that need your real numbers substituted before this
goes in front of anyone who controls a budget.

---

## The headline

**The technology is close to free. The cost is people.**

Running Xnith nationally through polling day costs roughly **R0 in new
infrastructure** — it runs on a server the business already pays for. The three
credential items cost nothing at all.

The entire cost of this system is the ground operation: the people standing at
polling stations photographing result slips. That is also the only part that
cannot be bought late.

---

## 1. Infrastructure — the small number

| Item | Cost | Notes |
|---|---|---|
| Server through 4 November | **~R0/month** | Already paid for. 6 vCPU / 12 GB / 200 GB, shared with the other sites |
| Dedicated VPS + managed Postgres | ~$85–210/mo | *Indicative range, not a quote.* The right first paid step, after the election |
| Full production tier | ~$265–760/mo | Not yet. Design toward it, adopt the month before it is needed |

**Recommendation: change nothing before 4 November.** The current box carries
this comfortably.

### One capacity finding that does need a decision

Result-slip photographs are the first thing that will fill the disk, and the
arithmetic is not marginal:

| Coverage | Stations | Slips | Photo storage at ~1.5 MB each |
|---|---:|---:|---:|
| Gauteng metros | 2,311 | 4,622 | ~7 GB |
| Gauteng, all | 2,836 | 6,197 | ~9 GB |
| All metros nationally | 5,015 | 10,030 | ~15 GB |
| **National** | **23,696** | **66,073** | **~97 GB** |

At 2.5 MB a photo the national figure is ~161 GB, on a 200 GB disk that is
already shared with zaaka.io and Locare. **At full national coverage this fills
the server.**

- **Fix, if national coverage happens:** object storage, roughly **$5–10/month**
  for 100 GB *(indicative)*, plus about a day of engineering to move slip images
  off the local disk.
- **If coverage is Gauteng or metros-only, this is not an issue** and needs no
  spend.

---

## 2. People — the real number

This is the dominant line item by a wide margin, and the only one with a
deadline that cannot move.

### What a marshal costs, per polling day

| Component | Estimate per person | Basis |
|---|---:|---|
| Transport and stipend | **R150–400** | *Assumption — substitute your actual rate* |
| Food | R50–80 | *Assumption* |
| Mobile data | **under R30** | Calculated: 2–3 photos at ~1.5 MB is under 5 MB. A 100 MB bundle is ample |
| **Total per marshal per day** | **~R230–510** | |

The data figure is the one I am confident in: **uploading result slips costs
almost nothing.** Whatever you pay people, airtime is not what makes this
expensive.

### What coverage costs, at one marshal per station

Using a mid estimate of **R350 per marshal per day**:

| Coverage | Stations | Marshals | Cost for polling day *(estimate)* |
|---|---:|---:|---:|
| Drill, 29 October | 20–40 | ~10 | **~R3,500** |
| Both drills, 29 + 31 Oct | 20–40 | ~10 | **~R7,000** |
| Gauteng metros | 2,311 | 2,311 | ~R809,000 |
| Gauteng, all | 2,836 | 2,836 | ~R993,000 |
| All metros nationally | 5,015 | 5,015 | ~R1.76m |
| **National** | **23,696** | **23,696** | **~R8.3m** |

**Read that table as a recruitment problem before a money problem.** The binding
constraint is not R8.3m, it is finding, rostering and briefing 23,696 people in
twelve days. That is not achievable from a standing start.

### The realistic recommendation

Cover what can be covered properly rather than thinly everywhere. A parallel
count at 2,836 Gauteng stations that is complete and verified is worth more than
a national count with holes in it — holes are exactly what a disputed result
gets attacked through.

**Suggested target: Gauteng in full (2,836 stations, ~R1m estimated), extending
to other metros if recruitment runs ahead of schedule.**

---

## 3. The five asks, costed and timed

| # | Ask | Cost | Time needed | Ready by 4 Nov? |
|---|---|---|---|---|
| 1 | Ten volunteers, 29 October | ~R3,500 *(est.)* | Days | **Yes** |
| 2 | Marshal roster with stations | R0 | Hours, once names exist | **Yes** |
| 3 | Meta Business Manager | R0 | **2–6 weeks** | **No** |
| 4 | IEC API credentials | R0 (expected) | Unknown — IEC controls it | **Uncertain** |
| 5 | Voters' roll station summary | R0 | Hours | **Yes** |
| — | Seat projection engine | R0 | ~2 days build + validation | **Yes, if started** |

### Where the timelines come from, and what they mean

**3 · Meta Business Manager will not be ready.** Business verification plus App
Review for the permissions this needs is a multi-week process with a real
rejection rate, and it has not been started. Starting today does not produce a
working sentiment feed by 4 November. **Start it anyway** — it is free, it is on
the critical path for every election after this one, and the clock only runs
once you begin.

**4 · The IEC request is drafted and has not been sent.** Send it today. A
public body may be quick or may not answer inside twelve days; plan the night
as though our own count is the only count, and treat the official feed as a
bonus if it arrives.

**2 · The roster is the one that blocks everything.** The mechanism is built,
the capture tokens work, and `reporter_roster.station_id` is empty on every row.
Until a marshal is attached to a station, readiness reads 0% whatever the ground
truth is, and a captured slip cannot be attributed. **This is hours of work and
it is the single highest-value thing on this page.**

---

## 4. What this adds up to

| Scenario | New infrastructure spend | Ground operation *(estimate)* | Total *(estimate)* |
|---|---:|---:|---:|
| Drills only, prove the chain | R0 | ~R7,000 | **~R7,000** |
| Gauteng metros on the night | R0 | ~R809,000 | **~R809,000** |
| Gauteng in full | R0 | ~R993,000 | **~R1.0m** |
| National | ~R2,000 (storage) | ~R8.3m | **~R8.3m** |

**The software is not the expense and never was.** What is being bought is the
ability to hold an independent, evidenced count of the election — and what that
costs is people on the ground, at a rate the party already understands.

---

## 5. What I would do with twelve days

1. **Today** — send the IEC request; start Meta Business Manager registration;
   extract the voters' roll station summary.
2. **Today or tomorrow** — put names and stations into the roster. Readiness
   goes from 0% to real the moment this happens.
3. **27 October** — confirm the ten drill volunteers, half at
   local-municipality stations so the three-ballot case is tested rather than
   assumed.
4. **29 and 31 October** — run both drills. These are the only occasions the
   capture chain meets real people before it matters.
5. **Week of 2 November** — recruit to the agreed coverage tier. Decide Gauteng
   versus national on recruitment reality, not ambition.
6. **Build in parallel** — the seat projection engine, validated against the
   published 2021 result so it is checkable rather than asserted.

---

*Station, ward, slip and storage figures: counted from the register on
23 October 2026. Hosting ranges: `ARCHITECTURE.md` §4, indicative and tracked
for firming up in `OPEN-QUESTIONS.md` Q11. Stipend and food rates: assumptions,
not quotes — substitute yours.*
