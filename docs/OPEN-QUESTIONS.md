# Open questions

Decisions that are not mine to make, or facts not yet confirmed. The Todo asks
for these to be tracked and checked off **with reasoning** when answered — so
an answered entry keeps its reasoning rather than just flipping to "done".

Status: `OPEN` · `ANSWERED` · `BLOCKED`

---

## Answered

### Q1 · Who are the 500,000 concurrent users? — `ANSWERED` 2026-10-21
**Answer:** ground resources on election day.
**Reasoning:** this decides the entire scaling model. With 23,699 voting
stations and 5–20 of our own people per station, 500,000 is a credible ceiling
for *registered devices* at full national saturation. It is not 500,000 held
connections — ground devices submit and poll, they do not hold sockets, which
collapses the infrastructure requirement by roughly 15×. Full working in
`ARCHITECTURE.md` §1.
**Consequence:** Tier 1 (one managed Postgres, 2–3 app nodes) covers it. Tier 2
is needed only for election week at saturation, and only once the provider app
exists.

### Q2 · How far into payments does Xnith go? — `ANSWERED` 2026-10-21
**Answer:** export payment instructions; no money moves through Xnith.
**Reasoning:** the right call, and not a close one. Taking payments in-app adds
PSP integration, FICA/KYC obligations, PCI scope, and tax and labour-law
exposure around whether providers are contractors or employees — none of which
is the problem Xnith exists to solve. Tracking work done and producing a
verified payment file keeps the useful part (an auditable record of who did
what) and leaves the money in the party's existing banking and payroll
controls, where the compliance already lives.
**Consequence:** L4 builds a payment *export*, with verification and an audit
trail. No PSP, no card data, no wallet.

### Q10 · Current VPS capacity — `ANSWERED` 2026-10-21
**Answer:** Cloud VPS 6 (2026) — 6 vCPU, 12 GB RAM, 200 GB disk, shared with
existing sites.
**Reasoning:** ample for staging and for the whole of 4 November, since
election-day load is tens of HQ operators rather than thousands of marshals.
**Consequence:** `DEPLOY-VPS.md` allocates 4 GB to Postgres and 2 GB to the
app, leaving ~6 GB for the existing sites and the OS. Watch the 200 GB once
result-slip photos are stored — that is the limit that bites first, not CPU.

---

## Open — needed before 4 November

### Q3 · Is the ward size tolerance 15% or 30% for 2026? — `ANSWERED` 2026-10-21
**Answer:** 30%.
**Reasoning:** the long-standing rule was 15% of each municipality's norm; the
MDB proposed 30% and it went to Cabinet in 2020. Taking 30% as the operative
figure for 2026.
**Consequence:** the heatmap band is norm ±30%, and the per-ward ceiling used
for capacity planning is norm × 1.30 — about 13% more headroom per ward than
15% would have given, which is what sets batch sizes for result slips and
sentiment volume.
**Still worth confirming from the data, and it is free to do so.** Once the
national ward register is loaded with registered voters per ward, compute every
ward's deviation from its own municipality's norm. If the distribution stops
dead just under 15%, the operative tolerance is 15% and the band needs
changing; a tail running out toward 30% confirms 30%. Exclude the 183 KZN wards
still under litigation from that inference. Because the tolerance lives in
`control_panel`, correcting it is one setting rather than a migration.

### Q4 · What exactly does the IEC publish for the station register? — `ANSWERED` 2026-10-21
**Answer:** an open JSON API — `https://api.elections.org.za/IECGIS/Help` — not
the per-province PDFs I expected.
**Reasoning, and it is the best news in the project so far:** the IEC's
*results* API needs the credentials that have blocked every real election
figure here since the start. The **GIS** service needs none. It also accepts
MDB demarcation codes directly, which is the same key municipalmoney uses, so
the two sources join with no translation table. The walk is
`WardByMunicipality` → `VotingDistrictByWard`, and the second call returns each
station's name, coordinates, street, suburb, town and type.
**Consequence:** national geography is loadable now rather than after the
results credentials arrive. `npm run sources:register` does it, resumably.
**Also corrected a mistake of mine:** ward and voting district are *not* the
same unit. Johannesburg ward 1 holds eight VDs. The drill-down is
ward → VD → station, three levels, which is what the Todo actually asked for.
**Still outstanding:** the GIS API serves no voters' roll, so
`registered_voters` is NULL for every ward loaded this way. The roll is the
remaining input the ward-size heatmap and any turnout model need — see Q16.

### Q16 · Where does the voters' roll per ward come from? — `OPEN`
The national register now has the geography but no registered-voter counts
outside the Gauteng demo set, whose numbers are synthetic and now labelled as
such in `ward.roll_source`.
**Why it matters:** it is the denominator. Without it there is no turnout, no
ward-size-versus-norm heatmap, and no turnout model — and the 30% tolerance
band cannot be verified against the data either.
**Interim:** `v_register_coverage.wards_with_real_roll` reads 0 outside
Gauteng, so nothing can quietly present a synthetic denominator as real.

#### Checked, 22 October — the three candidates are not equal

The first candidate does not exist in the form assumed. **The IEC's voter
registration statistics page is a screen, not a dataset.** It offers province
and municipality selectors and age/gender breakdowns, publishes a national
total (29,230,808 as at 29 September 2026), and provides **no ward or
voting-district breakdown and no file download of any kind**.
<https://www.elections.org.za/pw/StatsData/Voter-Registration-Statistics>

The second is real but manual. **Past results are downloadable without
credentials**, in Excel and PDF, and the local-government detailed results go
down to voting-district level.
<https://results.elections.org.za/home/Downloads/ME-Results>
The page needs a year selected before it lists reports, so this is a
browser-and-click job rather than a fetch, and it would have to be done per
municipality. Whether those files carry registered population per VD alongside
the votes is **unconfirmed** — turnout is calculated from a registered
population, so it is likely present, but nobody has opened one and looked.

The third — the results API — needs credentials, which are issued by emailing
`webmaster@elections.org.za`. There is no self-service signup and no published
turnaround. Requested 22 October.

**What this means for planning.** Past results have a public fallback that
costs effort and no permission. **The registered-voter denominator does not.**
If the API credentials do not arrive, Q16 stays open unless one of the
downloadable reports turns out to carry registered population — so the single
highest-value hour anyone can spend on this is **downloading one
local-government detailed result file and looking at its columns.** That
answers whether this question has a fallback at all, and it needs no
credentials, no code and no permission.

**Not on the critical path for 4 November.** Logistics, result-slip capture
and transcription all run on the register as it stands. Q16 gates the
projection and targeting layer — valuable, but it is not what the night
depends on.

### Q5 · Who operates the paste form on the day? — `ANSWERED` 2026-10-21
**Answer:** nobody, as the primary path. Ingest is automated.
**Reasoning:** the arithmetic killed the manual plan. One marshal per station
reporting every two hours is ~24,000 messages across the day for Gauteng alone
(3,446 stations) and ~166,000 nationally. A single operator pasting batches of
fifty would need about eight hours of continuous work for Gauteng with zero
slack, and national was impossible by a factor of roughly seven.
**Consequence:** the WhatsApp webhook is now item 7 in the 14-day plan. The
paste form **stays as the fallback**, deliberately — an automated pipeline with
no manual path is a single point of failure in a nicer interface. Both use the
same `parseLine()`, so a fault found in a drill is fixed in both at once.
**Still needed from you:** one or two people watching
`v_ingest_exceptions` on the day. That is a monitoring role, not data entry —
they handle the messages the parser refused, which should be a trickle.

### Q15 · Which route to the WhatsApp Business Platform? — `OPEN`, and time-critical
You have the WhatsApp Business **App**, which has no API access at all. The
programmable product is the WhatsApp Business **Platform** (Cloud API). Two
routes, and this is the gating decision for automated ingest:

**A — Dedicated reporting number (recommended).** Register a *new* number
directly on the Cloud API. No Solution Partner needed, no migration risk to
your existing business number, and it keeps election traffic out of the
business inbox. Marshals are told one number, once.

**B — Coexistence on your existing number.** Meta supports running the
Business App and Cloud API on one number; inbound messages arrive on the
standard `messages` webhook. But onboarding requires Embedded Signup as a
**Solution Partner or Tech Provider**, so it means going through a BSP, and
throughput is capped at 20 messages/second rather than 80. It also drops the
connection if the primary device is inactive for about 14 days.

**Recommendation: A.** It removes the Solution Partner gate, which is the one
dependency with an unpredictable timeline.
**What to check today, and it is a 20-minute job:** in Meta Business Manager,
whether you can add a real (non-test) phone number and receive inbound messages
before business verification completes. You only need to *receive* and to reply
inside the 24-hour service window — no marketing templates, no green tick —
which is the lightest possible use of the platform. If inbound works
unverified, ingest can be live this week.
**Fallback if Meta stalls:** paste form plus exception reporting, which is why
the form is being kept rather than replaced.

### Q6 · Driver location — consent, resolution and retention — `OPEN`
The sharpest POPIA edge in the project. Continuous location of an identifiable
individual is among the most sensitive categories of personal information, and
"resource allocation" is not on its own a sufficient basis.
**My recommendation**, for you to accept or change:
- Explicit, specific, withdrawable consent in the app — not a registration
  tick-box
- Captured **only while on an accepted assignment**; never background, never
  between shifts
- Stored **snapped to a route segment**, not as a raw GPS trail
- Retention in **days**, auto-purged by the existing nightly job
- Raw traces never reach the analytics layer or the extract

**Why it matters:** this is the decision most likely to be examined by someone
hostile, and the one where getting it right costs almost nothing up front and
is nearly impossible to retrofit.
**Blocks:** all of L4 driver tracking. Do not write it before this is settled.

---

## Open — post-election

### Q7 · Who may read the HQ ↔ ground message log, and for how long? — `OPEN`
A complete, auditable record of what HQ instructed the ground is exactly the
record an inquiry would subpoena. That is an argument for keeping it *clean*,
not for not keeping it — but access and retention need deciding before the
channel is built, not after it has a year of history.
**Blocks:** L3 beyond the WhatsApp ingest.

### Q8 · App store policy for a political party's app — `ANSWERED` 2026-10-21
**Answer:** moot. Distribution is a signed APK from the party website, so there
is no store review.
**Reasoning:** and this is the stronger argument for the decision. Google Play
restricts background location to apps where it is core functionality, reviews
each case individually, and states explicitly that following its guidance does
not guarantee approval. A political party's app tracking volunteer drivers'
location is precisely the submission that attracts scrutiny, on a timeline
nobody controls. Sideloading removes that from the critical path.
**Verified as viable:** Google's developer-verification enforcement started
30 September 2026 in Brazil, Indonesia, Singapore and Thailand only, for apps
from seven participating stores. Direct APK downloads are not covered anywhere
yet. South Africa is unaffected.
**Consequences, now tracked in `PROVIDER-APP.md`:** an in-app updater is
mandatory rather than optional, because a sideloaded APK never auto-updates;
register as a verified developer now ahead of the 2027 global expansion; publish
the APK hash; pin the signing certificate server-side; and guard the keystore,
which is the one unrecoverable loss in the plan.

### Q9 · Which maps and routing provider? — `OPEN`
Routing at national scale is a real recurring cost, and the obvious free
option is not licensed for commercial routing.
**Options:** Google Maps Platform (best SA coverage, most expensive),
Mapbox (cheaper, good enough), OpenRouteService / self-hosted OSRM on OSM
(cheapest, most work, no traffic model).
**Needs:** an estimate of monthly route requests, which needs Q5-style numbers
on how many drivers and assignments per day. Revisit with L4.

### Q11 · Firm hosting costs — `OPEN`
`ARCHITECTURE.md` §4 carries indicative ranges, not quotes. They should be
priced against two named providers before any Tier 1 commitment.
**Also needed:** the server spec at
`C:\Users\verno\OneDrive\Desktop\Venom` — I cannot read your Desktop from
here. Paste or attach it and I will diff the three options against it properly
rather than guessing at what it recommended.

### Q12 · MK brand assets — `OPEN`
You are sending the logo and brand guide. I will not invent official party
colours — I could not confirm a published palette from any authoritative
source, and guessing at a party's brand colours then hard-coding them into a
design system is how you end up with a system-wide find-and-replace later.
**On arrival:** palette becomes design tokens, three mockups follow, and the
standard is applied once rather than per screen.

### Q13 · Does the repository get renamed to `xnith`? — `OPEN`
See `GOTCHAS.md` G1. My recommendation is to rename *after* 4 November: GitHub
redirects old remotes, so it is safe, but it is pointless churn during a
freeze.

### Q14 · Result-slip capture on election night — `ANSWERED 22 Oct`
**Answer:** yes — the ground operation will realistically photograph and
transcribe slips on the night. Promoted out of `[POST]` and into the build.

Scoping it surfaced something the question itself had not: **a station does
not produce one slip.** A metro station produces two (ward + municipal PR) and
a local-municipality station three (plus district PR). Against the register
that is 5,070 metro and 18,681 local stations — **66,183 slips**, not 23,751.
A capture flow accepting "the slip" per station would have lost two of every
three counts across most of the country, and would have reported full coverage
while doing it.

Schema is in `029_result_slips.sql`: photographs kept separately from
transcriptions, every slip transcribed **twice by different operators**,
disagreements and failed reconciliations surfaced as views. What remains is
the upload path, the transcription screen, and the coverage screen.

Still open underneath it: marshals cannot send photographs through the
WhatsApp API while Meta is uncleared (Q15), so the capture path must not
depend on it — a page they open on a phone, with WhatsApp as an addition
later rather than the foundation.

<details><summary>Original question</summary>
Currently a `[POST]` candidate that could be promoted into the fortnight if
week one finishes early.
**Why it is time-critical in a way nothing else here is:** it is the only item
whose data **cannot be collected later**. Every other post-election task has
the same inputs on 5 November as it does on 3 November. This one does not.
**Needs from you:** whether the ground operation will realistically photograph
and transcribe slips on the night, because the feature is worthless without
that behaviour.
</details>
